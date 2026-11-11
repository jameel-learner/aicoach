import {
  blueprintChecks,
  conventionsExtractSchema,
  PARTS,
  questionExtractSchema,
  schemeExtractSchema,
  structureExtractSchema,
  topicsExtractSchema,
  type ConventionsExtract,
  type ExamStrategy,
  type ItemSource,
  type Part,
  type StrategyCheck,
  type StructureExtract,
  type TopicStat,
} from '@aicoach/core';
import {
  boardItems,
  boards,
  bookPages,
  books,
  examStrategies,
  levels,
  subjectOfferings,
  subjects,
  type Db,
} from '@aicoach/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { tidy, type StepRunner } from '../content/ingest';
import { InsufficientCredits } from '../credits/ledger';
import { platformWallet } from '../credits/wallets';
import type { Env } from '../env';
import type { ChatMessage } from '../llm/openrouter';
import { runMeteredChat } from '../llm/run';
import {
  BANK_PROMPT,
  CONVENTIONS_PROMPT,
  PAPER_PROMPT,
  SCHEME_PROMPT,
  STRUCTURE_PROMPT,
  TOPICS_PROMPT,
} from './prompts';

/**
 * CompileStrategy (architecture §3.5, decision 9.5-2): board material → tagged questions →
 * ExamStrategy draft for Admin review. Named, idempotent steps (re-running a step replaces its own
 * rows), so it runs in a Workflow on LOCAL and inline in tests.
 *
 *   structure → papers → question bank (in page order) → schemes → presentation → topics → assemble
 */

export interface CompileParams {
  strategyId: string;
  userId: string;
}

/** Pages of the question bank handed to the model at a time. */
const BANK_WINDOW = 12;
/** Question-bank pages before the questions start (pattern, instructions, index) go to "structure". */
const BANK_FRONT_PAGES = 5;
/** Thinking off for extraction: the work is careful reading, and thinking tokens cost output price. */
const REASONING = { max_tokens: 0 } as const;

type Book = typeof books.$inferSelect;

export { tidy };

async function pagesOf(db: Db, bookId: string, from = 1, to = 100_000) {
  const rows = await db
    .select({ pageNo: bookPages.pageNo, markdown: bookPages.markdown })
    .from(bookPages)
    .where(
      and(
        eq(bookPages.bookId, bookId),
        sql`${bookPages.pageNo} >= ${from}`,
        sql`${bookPages.pageNo} <= ${to}`,
      ),
    )
    .orderBy(asc(bookPages.pageNo));
  return rows.map((r) => `--- page ${r.pageNo} ---\n${tidy(r.markdown ?? '')}`).join('\n\n');
}

const setRun = (db: Db, id: string, values: Partial<typeof examStrategies.$inferInsert>) =>
  db
    .update(examStrategies)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(examStrategies.id, id));

async function readProgress(db: Db, id: string) {
  const row = await db
    .select({ progress: examStrategies.progress })
    .from(examStrategies)
    .where(eq(examStrategies.id, id))
    .get();
  return (row?.progress ?? {}) as { checkpoints?: Record<string, unknown> } & Record<
    string,
    unknown
  >;
}

/** Progress for the UI; keeps the step checkpoints. */
async function progress(
  db: Db,
  id: string,
  step: string,
  done: number,
  total: number,
  label: string,
) {
  const cur = await readProgress(db, id);
  await setRun(db, id, {
    progress: { step, done, total, label, checkpoints: cur.checkpoints ?? {} },
  });
}

/**
 * Runs a step once per compile run: its result is kept on the run, so continuing a stopped run
 * (e.g. the local dev server reloaded and killed the Workflow) skips finished, paid steps.
 */
async function once<T>(db: Db, id: string, key: string, fn: () => Promise<T>): Promise<T> {
  const before = await readProgress(db, id);
  if (before.checkpoints && key in before.checkpoints) return before.checkpoints[key] as T;
  const value = await fn();
  const cur = await readProgress(db, id);
  await setRun(db, id, {
    progress: { ...cur, checkpoints: { ...(cur.checkpoints ?? {}), [key]: value ?? null } },
  });
  return value;
}

/** "22." / "Q22" / "22)" → "22" (to match scheme answers to paper questions). */
export const normQno = (q: string) =>
  q
    .replace(/^[^0-9]*/, '')
    .replace(/[^0-9a-z]+$/i, '')
    .trim();

/** One model call that must return JSON matching `schema`; one retry with the error. */
async function askJson<S extends z.ZodTypeAny>(
  env: Env,
  db: Db,
  run: { id: string; userId: string },
  schema: S,
  system: string,
  user: string,
  maxTokens: number,
): Promise<z.infer<S>> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await runMeteredChat(env, db, {
      task: 'board_analysis',
      payers: [await platformWallet(db)],
      userId: run.userId,
      maxTokens,
      responseFormat: { type: 'json_object' },
      reasoning: REASONING,
      messages,
    });
    await db
      .update(examStrategies)
      .set({ costUsdNano: sql`${examStrategies.costUsdNano} + ${res.rawUsdNano}` })
      .where(eq(examStrategies.id, run.id));
    let problem: string;
    try {
      const raw = JSON.parse(
        res.content
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/```$/, ''),
      );
      const parsed = schema.safeParse(raw);
      if (parsed.success) return parsed.data;
      const issue = parsed.error.issues[0];
      problem = `${issue?.path.join('.')}: ${issue?.message}`;
    } catch (err) {
      problem = `not valid JSON (${err instanceof Error ? err.message : String(err)})`;
    }
    messages.push(
      { role: 'assistant', content: res.content.slice(0, 4000) },
      {
        role: 'user',
        content: `That reply did not match the required shape (${problem}). Reply again with the complete JSON object only.`,
      },
    );
  }
  throw new Error('The model did not return valid JSON after a retry');
}

/** Five rows per INSERT: ~16 bound values each keeps every statement under D1's 100 limit. */
async function insertItems(db: Db, rows: (typeof boardItems.$inferInsert)[]) {
  for (let i = 0; i < rows.length; i += 50) {
    const stmts = [];
    for (let j = i; j < Math.min(rows.length, i + 50); j += 5)
      stmts.push(db.insert(boardItems).values(rows.slice(j, Math.min(j + 5, i + 50))));
    if (stmts.length) await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);
  }
}

/** "Board paper 2025-26 · 30_QP_EXAM1_2026" → "30_QP_EXAM1_2026"; exam year from the academic year. */
const paperLabelOf = (b: Book) => b.title.split('·').pop()!.trim();
const examYearOf = (b: Book) => {
  const m = /^(\d{4})-(\d{2})$/.exec(b.academicYear ?? '');
  return m ? Number(m[1]) + 1 : null;
};

const chapterList = (s: StructureExtract) =>
  s.chapters.map((c) => `${c.no}. ${c.title}`).join('\n');

// ------------------------------------------------------------------ steps

async function stepStructure(env: Env, db: Db, run: Run, docs: Book[]) {
  const blueprint = docs.find((d) => d.category === 'blueprint');
  if (!blueprint) throw new Error('No published blueprint: upload and publish one first');
  const bank = docs.find((d) => d.category === 'question_bank');
  const text = [
    `=== Blueprint: ${blueprint.title} ===\n${await pagesOf(db, blueprint.id)}`,
    bank
      ? `=== Question bank instructions: ${bank.title} ===\n${await pagesOf(db, bank.id, 1, BANK_FRONT_PAGES)}`
      : '',
  ].join('\n\n');
  return askJson(
    env,
    db,
    run,
    structureExtractSchema,
    STRUCTURE_PROMPT.system,
    STRUCTURE_PROMPT.user(text),
    8000,
  );
}

async function stepPaper(env: Env, db: Db, run: Run, s: StructureExtract, b: Book) {
  const res = await askJson(
    env,
    db,
    run,
    questionExtractSchema,
    PAPER_PROMPT.system(chapterList(s)),
    PAPER_PROMPT.user(await pagesOf(db, b.id)),
    16000,
  );
  const source: ItemSource = b.category === 'board_paper' ? 'board_exam' : 'model_paper';
  await db
    .delete(boardItems)
    .where(and(eq(boardItems.strategyId, run.id), eq(boardItems.bookId, b.id)));
  await insertItems(
    db,
    res.questions.map((q) => ({
      strategyId: run.id,
      bookId: b.id,
      page: q.page,
      source,
      paperLabel: paperLabelOf(b),
      examYear: source === 'board_exam' ? examYearOf(b) : null,
      qno: normQno(q.qno) || q.qno,
      part: q.part,
      marks: q.marks,
      chapter: q.chapter,
      topic: q.topic,
      typology: q.typology,
      cognitive: q.cognitive,
      difficulty: q.difficulty,
      text: q.text,
    })),
  );
  return res.questions.length;
}

async function stepBankWindow(
  env: Env,
  db: Db,
  run: Run,
  s: StructureExtract,
  b: Book,
  from: number,
  to: number,
  context: string | null,
  index: string,
) {
  const res = await askJson(
    env,
    db,
    run,
    questionExtractSchema,
    BANK_PROMPT.system(chapterList(s)),
    BANK_PROMPT.user(index, context, await pagesOf(db, b.id, from, to)),
    16000,
  );
  await db
    .delete(boardItems)
    .where(
      and(
        eq(boardItems.strategyId, run.id),
        eq(boardItems.bookId, b.id),
        sql`${boardItems.page} >= ${from}`,
        sql`${boardItems.page} <= ${to}`,
      ),
    );
  await insertItems(
    db,
    res.questions.map((q) => ({
      strategyId: run.id,
      bookId: b.id,
      // A page outside the window would escape the step's clean-up: clamp it.
      page: Math.min(to, Math.max(from, q.page ?? from)),
      source: q.source ?? 'bank',
      paperLabel: q.source && q.source !== 'bank' ? q.paperLabel : null,
      examYear: q.source === 'board_exam' ? q.examYear : null,
      qno: normQno(q.qno) || q.qno,
      part: q.part,
      marks: q.marks,
      chapter: q.chapter,
      topic: q.topic,
      typology: q.typology,
      cognitive: q.cognitive,
      difficulty: q.difficulty,
      text: q.text,
    })),
  );
  return res.endsIn;
}

async function stepScheme(env: Env, db: Db, run: Run, scheme: Book) {
  if (!scheme.relatedBookId) return 0;
  const items = await db
    .select({ id: boardItems.id, qno: boardItems.qno })
    .from(boardItems)
    .where(and(eq(boardItems.strategyId, run.id), eq(boardItems.bookId, scheme.relatedBookId)));
  if (!items.length) return 0;
  const res = await askJson(
    env,
    db,
    run,
    schemeExtractSchema,
    SCHEME_PROMPT.system,
    SCHEME_PROMPT.user(items.map((i) => i.qno).join(', '), await pagesOf(db, scheme.id)),
    16000,
  );
  let matched = 0;
  const stmts = [];
  for (const a of res.answers) {
    const item = items.find((i) => i.qno === normQno(a.qno));
    if (!item) continue;
    matched++;
    stmts.push(
      db
        .update(boardItems)
        .set({
          answer: a.note ? `${a.answer}\n(${a.note})` : a.answer,
          markSplit: a.markSplit,
          markingPoints: a.markingPoints,
        })
        .where(eq(boardItems.id, item.id)),
    );
  }
  for (let i = 0; i < stmts.length; i += 40)
    await db.batch(stmts.slice(i, i + 40) as unknown as Parameters<typeof db.batch>[0]);
  return matched;
}

async function stepConventions(env: Env, db: Db, run: Run, docs: Book[]) {
  const scripts = docs.filter((d) => d.category === 'answer_script');
  if (!scripts.length) return { conventions: [] } satisfies ConventionsExtract;
  const text = (
    await Promise.all(
      scripts.map(
        async (s, i) => `=== Script ${i + 1}: ${s.title} ===\n${await pagesOf(db, s.id)}`,
      ),
    )
  ).join('\n\n');
  return askJson(
    env,
    db,
    run,
    conventionsExtractSchema,
    CONVENTIONS_PROMPT.system,
    CONVENTIONS_PROMPT.user(text.slice(0, 400_000)),
    8000,
  );
}

async function stepTopics(env: Env, db: Db, run: Run, s: StructureExtract, chapter: number) {
  const items = await db
    .select({
      id: boardItems.id,
      part: boardItems.part,
      marks: boardItems.marks,
      topic: boardItems.topic,
    })
    .from(boardItems)
    .where(and(eq(boardItems.strategyId, run.id), eq(boardItems.chapter, chapter)));
  if (!items.length) return 0;
  const key = (i: number) => `i${i}`;
  const lines = items
    .map((it, i) => `${key(i)} | ${it.part ?? '-'} | ${it.marks ?? '-'} | ${it.topic}`)
    .join('\n');
  const title = s.chapters.find((c) => c.no === chapter)?.title ?? `Chapter ${chapter}`;
  const res = await askJson(
    env,
    db,
    run,
    topicsExtractSchema,
    TOPICS_PROMPT.system,
    TOPICS_PROMPT.user(`${chapter}. ${title}`, lines),
    12000,
  );
  const stmts = [];
  for (const t of res.topics)
    for (const k of t.items) {
      const it = items[Number(k.replace(/^i/, ''))];
      if (it)
        stmts.push(
          db.update(boardItems).set({ topicGroup: t.name }).where(eq(boardItems.id, it.id)),
        );
    }
  for (let i = 0; i < stmts.length; i += 40)
    await db.batch(stmts.slice(i, i + 40) as unknown as Parameters<typeof db.batch>[0]);
  // Items the model left out keep their own topic as the group.
  await db
    .update(boardItems)
    .set({ topicGroup: sql`${boardItems.topic}` })
    .where(
      and(
        eq(boardItems.strategyId, run.id),
        eq(boardItems.chapter, chapter),
        isNull(boardItems.topicGroup),
      ),
    );
  return res.topics.length;
}

// ------------------------------------------------------------------ assemble (no model calls)

type Item = typeof boardItems.$inferSelect;

/** "01", "6X1=6", "(4+1+1)=6", "each item 1 mark:6X1=6" → one spelling each, so splits group. */
export const normSplit = (x: string) =>
  x
    .replace(/\b0+(\d)/g, '$1')
    .replace(/\s*([x×X*])\s*(?=\d)/g, '×')
    .replace(/^\((.*)\)\s*=/, '$1=')
    .replace(/\s*([+=:])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const count = <T extends string | number>(xs: T[]) =>
  xs.reduce<Record<string, number>>((m, x) => ((m[String(x)] = (m[String(x)] ?? 0) + 1), m), {});

export function assembleStrategy(
  meta: { board: string; className: string; subject: string; offeringId: string },
  s: StructureExtract,
  items: Item[],
  conventions: ConventionsExtract,
  docs: Book[],
): ExamStrategy {
  const exam = items.filter((i) => i.source === 'board_exam');
  const model = items.filter((i) => i.source === 'model_paper');
  const examLabels = [...new Set(exam.map((i) => i.paperLabel ?? '?'))].sort();
  const years = [...new Set(exam.map((i) => i.examYear).filter((y): y is number => !!y))].sort();
  const minutesPerMark = s.durationMin / s.maxMarks;

  const chapters = s.chapters.map((c) => {
    const inCh = items.filter((i) => i.chapter === c.no);
    const groups = new Map<string, Item[]>();
    for (const it of inCh) {
      const g = it.topicGroup ?? it.topic;
      groups.set(g, [...(groups.get(g) ?? []), it]);
    }
    const topics: TopicStat[] = [...groups.entries()]
      .map(([name, list]) => ({
        name,
        examPapers: new Set(list.filter((i) => i.source === 'board_exam').map((i) => i.paperLabel))
          .size,
        examYears: [
          ...new Set(
            list.filter((i) => i.source === 'board_exam' && i.examYear).map((i) => i.examYear!),
          ),
        ].sort(),
        modelPapers: new Set(
          list.filter((i) => i.source === 'model_paper').map((i) => i.paperLabel),
        ).size,
        bankItems: list.filter((i) => i.source === 'bank').length,
        parts: [...new Set(list.map((i) => i.part).filter((p): p is Part => !!p))].sort(),
        marks: [...new Set(list.map((i) => i.marks).filter((m): m is number => !!m))].sort(
          (a, b) => a - b,
        ),
      }))
      .sort(
        (a, b) =>
          b.examPapers - a.examPapers || b.modelPapers - a.modelPapers || b.bankItems - a.bankItems,
      );
    return {
      ...c,
      topics,
      examAppearances: exam.filter((i) => i.chapter === c.no).length,
      problemSpecs: s.problemSpecs
        .filter((p) => p.chapter === c.no)
        .map((p) => ({ part: p.part, allowed: p.allowed })),
    };
  });

  const parts = s.parts.map((p) => ({
    ...p,
    marksOnPaper: p.asked * p.marksEach,
    marksToAnswer: p.toAnswer * p.marksEach,
    minutesPerQuestion: Math.round(p.marksEach * minutesPerMark * 10) / 10,
  }));

  const typologyByPart = Object.fromEntries(
    PARTS.map((p) => [
      p,
      count([...exam, ...model].filter((i) => i.part === p).map((i) => i.typology)),
    ]),
  ) as Record<Part, Record<string, number>>;

  const splits = new Map<string, { part: Part; split: string; count: number }>();
  for (const it of items)
    if (it.markSplit && it.part) {
      const split = normSplit(it.markSplit);
      const k = `${it.part}|${split.toLowerCase()}`;
      const cur = splits.get(k) ?? { part: it.part, split, count: 0 };
      cur.count++;
      splits.set(k, cur);
    }
  const markSplits = [...splits.values()].sort(
    (a, b) => a.part.localeCompare(b.part) || b.count - a.count,
  );

  // Checks: the blueprint's own arithmetic + each analysed exam paper against the pattern.
  const checks: StrategyCheck[] = blueprintChecks(s);
  const expectedPerPart = Object.fromEntries(s.parts.map((p) => [p.part, p.asked]));
  for (const label of examLabels) {
    const qs = exam.filter((i) => i.paperLabel === label);
    const off = (['B', 'C', 'D'] as Part[]).filter(
      (p) => qs.filter((i) => i.part === p).length !== expectedPerPart[p],
    );
    checks.push({
      name: `Board paper ${label} follows the pattern (parts B, C, D)`,
      ok: off.length === 0,
      detail: off.length
        ? off
            .map(
              (p) =>
                `part ${p}: ${qs.filter((i) => i.part === p).length} found, ${expectedPerPart[p]} expected`,
            )
            .join('; ')
        : `${qs.length} questions`,
    });
  }
  const untagged = items.filter((i) => i.chapter == null && i.typology !== 'match').length;
  checks.push({
    name: 'Questions have a chapter',
    ok: untagged <= items.length * 0.05,
    detail: `${untagged} of ${items.length} without a chapter`,
  });

  // Priorities (plain language, computed from the numbers above).
  const priorities: string[] = [];
  const longest = [...parts].sort((a, b) => b.marksEach - a.marksEach)[0];
  if (longest && longest.asked > longest.toAnswer) {
    const chs = s.chapters.filter(
      (c) => ({ A: c.partA, B: c.partB, C: c.partC, D: c.partD })[longest.part] > 0,
    );
    priorities.push(
      `Part ${longest.part} (${longest.marksEach} marks each) is ${Math.round((longest.marksToAnswer / s.maxMarks) * 100)}% of the marks and you choose ${longest.toAnswer} of ${longest.asked}: master at least ${longest.toAnswer + 1} of these chapters (one spare): ${chs.map((c) => `${c.no} ${c.title}`).join('; ')}.`,
    );
  }
  const inBC = s.chapters.filter((c) => c.partB > 0 && c.partC > 0);
  if (inBC.length)
    priorities.push(
      `Chapters in both Part B and Part C (theory and 6-mark problems): ${inBC.map((c) => `${c.no} ${c.title}`).join('; ')}.`,
    );
  const partA = parts.find((p) => p.part === 'A');
  if (partA && partA.asked === partA.toAnswer)
    priorities.push(
      `Part A (${partA.marksToAnswer} marks) is compulsory and covers every chapter: revise definitions, terms, formats and ratios of all chapters.`,
    );
  const hot = chapters
    .flatMap((c) => c.topics.map((t) => ({ ...t, chapter: c.no })))
    .filter((t) => t.examPapers > 1)
    .sort((a, b) => b.examPapers - a.examPapers)
    .slice(0, 8);
  if (hot.length)
    priorities.push(
      `Asked most often in the ${examLabels.length} board papers analysed: ${hot.map((t) => `${t.name} (ch ${t.chapter}, ${t.examPapers} papers)`).join('; ')}.`,
    );
  priorities.push(
    `Time: about ${minutesPerMark.toFixed(2)} minutes per mark (${parts.map((p) => `${p.marksEach}-mark ≈ ${p.minutesPerQuestion} min`).join(', ')}), plus ${s.readingTimeMin} minutes reading time.`,
  );

  return {
    schema: 'exam_strategy@1',
    ...meta,
    academicYear: s.academicYear,
    durationMin: s.durationMin,
    readingTimeMin: s.readingTimeMin,
    maxMarks: s.maxMarks,
    questionsOnPaper: s.questionsOnPaper,
    minutesPerMark: Math.round(minutesPerMark * 100) / 100,
    parts,
    chapters,
    exams: { papers: examLabels.length, years, labels: examLabels },
    modelPapers: new Set(model.map((i) => i.paperLabel)).size,
    typologyByPart,
    cognitive: count(items.map((i) => i.cognitive ?? 'unknown')),
    difficulty: count(
      items.filter((i) => i.source === 'bank' && i.difficulty).map((i) => i.difficulty!),
    ),
    markSplits,
    answerConventions: conventions.conventions,
    priorities,
    notes: s.notes,
    checks,
    sources: docs.map((d) => ({
      bookId: d.id,
      title: d.title,
      category: d.category ?? 'board_material',
      academicYear: d.academicYear,
    })),
    stats: {
      questions: items.length,
      withMarking: items.filter((i) => i.markSplit || i.markingPoints?.length).length,
      bankItems: items.filter((i) => i.source === 'bank').length,
      examItems: exam.length,
    },
  };
}

/**
 * Inside the question bank, a "paper" with fewer than this share of the pattern's questions is a
 * note on a chapter-wise question (e.g. "(Exam-1)"), not a paper. Uploaded paper documents are
 * always papers.
 */
const MIN_PAPER_SHARE = 0.4;

/**
 * Assembles (or re-assembles after an Admin correction) a run's strategy from its tagged items and
 * the checkpointed pattern + presentation steps. No model calls. Fragments that aren't whole papers
 * (a bank question annotated "(Exam-1)") are folded back into the question bank first.
 */
export async function assembleRun(db: Db, runId: string) {
  const row = await db.select().from(examStrategies).where(eq(examStrategies.id, runId)).get();
  if (!row) throw new Error('Strategy run not found');
  const cp = ((row.progress ?? {}) as { checkpoints?: Record<string, unknown> }).checkpoints ?? {};
  const s = cp.structure as StructureExtract | undefined;
  if (!s) throw new Error('This run has no paper pattern yet');
  const conventions = (cp.conventions as ConventionsExtract | undefined) ?? { conventions: [] };
  const docs = await db
    .select()
    .from(books)
    .where(inArray(books.id, row.sourceBookIds.slice(0, 90)));

  const groups = await db
    .select({ bookId: boardItems.bookId, label: boardItems.paperLabel, n: sql<number>`count(*)` })
    .from(boardItems)
    .where(and(eq(boardItems.strategyId, runId), sql`${boardItems.source} != 'bank'`))
    .groupBy(boardItems.bookId, boardItems.paperLabel);
  const minQuestions = Math.ceil(MIN_PAPER_SHARE * s.parts.reduce((n, p) => n + p.asked, 0));
  const bankIds = new Set(docs.filter((d) => d.category === 'question_bank').map((d) => d.id));
  for (const g of groups)
    if (bankIds.has(g.bookId) && Number(g.n) < minQuestions)
      await db
        .update(boardItems)
        .set({ source: 'bank', paperLabel: null, examYear: null })
        .where(
          and(
            eq(boardItems.strategyId, runId),
            eq(boardItems.bookId, g.bookId),
            g.label === null ? isNull(boardItems.paperLabel) : eq(boardItems.paperLabel, g.label),
            sql`${boardItems.source} != 'bank'`,
          ),
        );

  const meta = await db
    .select({ board: boards.code, className: levels.name, subject: subjects.name })
    .from(subjectOfferings)
    .innerJoin(boards, eq(boards.id, subjectOfferings.boardId))
    .innerJoin(levels, eq(levels.id, subjectOfferings.levelId))
    .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
    .where(eq(subjectOfferings.id, row.offeringId))
    .get();
  const items = await db.select().from(boardItems).where(eq(boardItems.strategyId, runId));
  const strategy = assembleStrategy(
    {
      board: meta?.board ?? '?',
      className: meta?.className ?? '?',
      subject: meta?.subject ?? '?',
      offeringId: row.offeringId,
    },
    s,
    items,
    conventions,
    docs,
  );
  await setRun(db, runId, {
    status: 'draft',
    statusMessage: null,
    strategy,
    progress: {
      step: 'done',
      done: 1,
      total: 1,
      label: 'Ready for review',
      checkpoints: (await readProgress(db, runId)).checkpoints ?? {},
    },
  });
  return strategy.stats.questions;
}

// ------------------------------------------------------------------ the run

type Run = { id: string; userId: string };

export async function runCompile(env: Env, db: Db, p: CompileParams, step: StepRunner) {
  const run = { id: p.strategyId, userId: p.userId };
  try {
    const row = await db.select().from(examStrategies).where(eq(examStrategies.id, run.id)).get();
    if (!row) throw new Error('Strategy run not found');
    const docs = await db
      .select()
      .from(books)
      .where(inArray(books.id, row.sourceBookIds.slice(0, 90)));
    const papers = docs.filter((d) => d.category === 'board_paper' || d.category === 'model_paper');
    const bank = docs.find((d) => d.category === 'question_bank');
    const schemes = docs.filter((d) => d.category === 'scheme');

    await progress(db, run.id, 'structure', 0, 1, 'Reading the paper pattern');
    const s = await step.do('structure', () =>
      once(db, run.id, 'structure', () => stepStructure(env, db, run, docs)),
    );

    for (const [i, b] of papers.entries()) {
      await progress(db, run.id, 'papers', i, papers.length, `Tagging ${b.title}`);
      await step.do(`paper ${b.id}`, () =>
        once(db, run.id, `paper ${b.id}`, () => stepPaper(env, db, run, s, b)),
      );
    }

    if (bank) {
      let context: string | null = null;
      // The bank's index (which pages are chapters, board exams, model and practice papers).
      const index = await pagesOf(db, bank.id, 1, BANK_FRONT_PAGES);
      const windows: [number, number][] = [];
      for (let a = BANK_FRONT_PAGES + 1; a <= bank.pageCount; a += BANK_WINDOW)
        windows.push([a, Math.min(bank.pageCount, a + BANK_WINDOW - 1)]);
      for (const [i, [a, b]] of windows.entries()) {
        await progress(db, run.id, 'bank', i, windows.length, `Question bank pages ${a}-${b}`);
        const ctx: string | null = context;
        context = await step.do(`bank ${a}-${b}`, () =>
          once(db, run.id, `bank ${a}-${b}`, () =>
            stepBankWindow(env, db, run, s, bank, a, b, ctx, index),
          ),
        );
      }
    }

    for (const [i, sc] of schemes.entries()) {
      await progress(db, run.id, 'schemes', i, schemes.length, `Marking from ${sc.title}`);
      await step.do(`scheme ${sc.id}`, () =>
        once(db, run.id, `scheme ${sc.id}`, () => stepScheme(env, db, run, sc)),
      );
    }

    await progress(db, run.id, 'conventions', 0, 1, 'Presentation from centum scripts');
    // Kept as a checkpoint; assembleRun reads it from there (also when reassembling later).
    await step.do('conventions', () =>
      once(db, run.id, 'conventions', () => stepConventions(env, db, run, docs)),
    );

    for (const [i, c] of s.chapters.entries()) {
      await progress(db, run.id, 'topics', i, s.chapters.length, `Topics of chapter ${c.no}`);
      await step.do(`topics ${c.no}`, () =>
        once(db, run.id, `topics ${c.no}`, () => stepTopics(env, db, run, s, c.no)),
      );
    }

    await progress(db, run.id, 'assemble', 0, 1, 'Assembling the strategy');
    await step.do('assemble', () => assembleRun(db, run.id));
  } catch (err) {
    const msg =
      err instanceof InsufficientCredits
        ? 'The platform wallet ran out of credits. Issue platform credits, then compile again.'
        : `Stopped: ${err instanceof Error ? err.message : String(err)}`;
    await setRun(db, run.id, { status: 'failed', statusMessage: msg.slice(0, 500) });
    throw err;
  }
}
