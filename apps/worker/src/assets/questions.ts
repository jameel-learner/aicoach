import {
  examBudget,
  PART_MARKS,
  PARTS,
  questionSetSchema,
  questionsPerSet,
  slotKey,
  type AssetCheck,
  type AssetSource,
  type ExamStrategy,
  type GeneratedQuestion,
  type Part,
  type QuestionSet,
} from '@aicoach/core';
import { boardItems, learningAssets, type Db } from '@aicoach/db';
import { and, eq, sql } from 'drizzle-orm';
import { retrieve, type Source } from '../content/retrieve';
import { embedder } from '../content/store';
import type { Env } from '../env';
import { splitTotal, tallyProblems, words } from './checks';
import { saveVersion, strategyOf, textbookTags, writeCritiqueFix, type SlotRef } from './shared';

/**
 * Our own question bank (architecture §7 Phase 3): per chapter × marks level the blueprint asks
 * the chapter at (slot `questions:<ch>:<title>:<marks>`), board-style NEW questions with type,
 * difficulty, thinking level, a model answer as a centum script presents it, marking points and a
 * textbook citation. Same pipeline as notes and cards. Then, without a model call: near-duplicates
 * inside the set are removed and questions too close to a past board question are flagged
 * (embeddings compared in memory, decision 9.5-6: not Vectorize, which holds the shared content
 * store and is only ever added to).
 */

export const QUESTIONS_PROMPT_VERSION = 'questions@1';
/** Cosine similarity (bge-m3): above DUPLICATE two of our questions ask the same thing; above COPY one is a near copy of a past question. */
export const DUPLICATE = 0.92;
export const COPY = 0.94;

export interface QuestionSlot extends SlotRef {
  chapterTitle: string;
  part: Part;
}

/** One set per chapter and part the blueprint asks the chapter in (A 1, B 2, C 6, D 12 marks). */
export function planQuestionSlots(s: ExamStrategy, chapters: number[] | null): QuestionSlot[] {
  const out: QuestionSlot[] = [];
  for (const c of s.chapters) {
    if (chapters && !chapters.includes(c.no)) continue;
    for (const part of PARTS) {
      if (!((c[`part${part}` as 'partA'] ?? 0) > 0)) continue;
      const marks = s.parts?.find((p) => p.part === part)?.marksEach ?? PART_MARKS[part];
      out.push({
        key: slotKey('questions', c.no, c.title, marks),
        chapter: c.no,
        chapterTitle: c.title,
        topic: c.title,
        marks,
        part,
      });
    }
  }
  return out;
}

export interface QuestionsContext {
  board: string;
  className: string;
  subject: string;
  chapter: number;
  chapterTitle: string;
  part: Part;
  marks: number;
  count: number;
  exam: { minutes: number; maxWords: number };
  topics: { name: string; examPapers: number; marks: number[] }[];
  /** Question types of this part and how often the board uses each. */
  typology: Record<string, number>;
  difficulty: Record<string, number>;
  allowed: string[];
  instructions: string[];
  examples: {
    label: string;
    typology: string;
    text: string;
    markSplit: string | null;
    answer: string | null;
  }[];
  conventions: { format: string; rule: string }[];
  excerpts: { n: number; page: number; section: string | null; text: string }[];
}

const JSON_ONLY = 'Reply with ONE JSON object only (no Markdown fences, no commentary).';
const pct = (r: Record<string, number>) => {
  const total = Object.values(r).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(r)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${Math.round((v / total) * 100)}%`)
    .join(', ');
};

const contextText = (c: QuestionsContext) =>
  [
    `Subject: ${c.board} ${c.className} ${c.subject}`,
    `Chapter ${c.chapter}: ${c.chapterTitle}`,
    `Write ${c.count} questions for Part ${c.part}: ${c.marks} mark${c.marks === 1 ? '' : 's'} each, about ${c.exam.minutes} minutes each in the exam (model answer at most about ${c.exam.maxWords} words, counting every number and table cell).`,
    Object.keys(c.typology).length
      ? `Question types the board uses in this part: ${pct(c.typology)}.`
      : '',
    Object.keys(c.difficulty).length ? `Difficulty mix in board papers: ${pct(c.difficulty)}.` : '',
    c.allowed.length
      ? `The board's allowed problem types for this chapter in this part:\n${c.allowed.map((a) => `- ${a}`).join('\n')}`
      : '',
    c.instructions.length
      ? `The blueprint's instructions for this part:\n${c.instructions.map((i) => `- ${i}`).join('\n')}`
      : '',
    `Topics (with how many board papers asked them, and at which marks):\n${c.topics
      .map((t) => `- ${t.name} (${t.examPapers} papers; ${t.marks.join('/') || '1'} marks)`)
      .join('\n')}`,
    c.examples.length
      ? `Past board / model questions from this chapter at this level (for STYLE only; never copy them):\n${c.examples
          .map(
            (e) =>
              `- [${e.label}, ${e.typology}] ${e.text}${e.markSplit ? ` | marks: ${e.markSplit}` : ''}${e.answer ? ` | scheme: ${e.answer.slice(0, 300)}` : ''}`,
          )
          .join('\n')}`
      : '',
    c.conventions.length
      ? `How full-marks answers are presented (from centum answer scripts):\n${c.conventions.map((r) => `- (${r.format}) ${r.rule}`).join('\n')}`
      : '',
    `Textbook excerpts (cite as S#):\n\n${c.excerpts
      .map((e) => `[S${e.n}] (page ${e.page}${e.section ? `, ${e.section}` : ''})\n${e.text}`)
      .join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');

const SHAPE =
  '{"questions":[{"topic":"topic name from the list","typology":"mcq|fill_blank|match|very_short|expand|true_false|short_answer|problem","difficulty":"easy|average|hots","cognitive":"remember|understand|apply|analyse","question":"Markdown","options":["a","b","c","d"] or null,"answer":"Markdown","markingPoints":[{"point":"...","marks":1}],"marksSplit":"1+1=2","cite":"S2"}]}';

export const QUESTIONS_WRITER_PROMPT = {
  system: [
    'You write NEW board-exam questions with model answers and marking points, for a question bank students practise with.',
    JSON_ONLY,
    `Shape: ${SHAPE}`,
    'Rules:',
    '- Exactly the number of questions asked, all at the marks given, in the style of the board questions shown but NEW (your own wording and numbers; never a copy or a light rewording of a past question). No two questions may ask the same thing.',
    '- Every fact, rule and format comes ONLY from the textbook excerpts; "cite" names the excerpt the question rests on (e.g. "S2").',
    '- Spread the questions over the topics (more on topics asked in more papers), the question types and the difficulty mix given. For 6 and 12 marks, follow the allowed problem types.',
    '- MCQ: exactly 4 options, one correct; the answer states the correct option. Fill in the blank: the answer is the missing word(s). Match: the question lists both columns; the answer gives the pairs. True/false: the answer says which and why in one line.',
    '- answer: the full-marks answer exactly as a centum script presents it (journal entries, ledger accounts and statements as Markdown tables with Dr and Cr sides and totals that tally; brief working notes), writable in the minutes given. Check every figure.',
    '- markingPoints: what the examiner awards marks for, as a scheme of evaluation lists them; their marks add up to the question\'s marks. marksSplit the same in short (e.g. "2+2+1+1=6"; may be null for 1 mark).',
    '- difficulty: easy (recall, one step), average (two or three steps), hots (analyse, combine, a twist). cognitive: remember, understand, apply or analyse.',
  ].join('\n'),
  user: (c: QuestionsContext) => contextText(c),
} as const;

export const QUESTIONS_CRITIC_PROMPT = {
  system: [
    'You are a strict senior examiner reviewing new exam questions with model answers and marking points. Find real problems; do not rewrite them.',
    JSON_ONLY,
    'Shape: {"scores":{"accuracy":1-5,"grounded":1-5,"marksFit":1-5,"presentation":1-5,"clarity":1-5},"issues":[{"severity":"major|minor","where":"question N","problem":"...","fix":"..."}],"verdict":"pass|fix"}',
    '- accuracy: every model answer is right. RECOMPUTE each problem: each amount, each total, both sides of every account, the balance sheet. A wrong answer, an MCQ with no or two correct options, or marking points that do not add up to the marks are major issues.',
    '- grounded: the question and answer rest on the cited excerpt; anything outside the textbook is a major issue.',
    "- marksFit: each question earns exactly its marks, suits the part's question types and the allowed problem types, and its answer can be written in the minutes given. A near copy of a past board question, or two questions asking the same thing, is a major issue.",
    '- presentation: answers follow the presentation rules (journal narrations, ledger Dr/Cr, Schedule III, working notes); marking points as a scheme of evaluation writes them.',
    '- clarity: each question is unambiguous; a student knows exactly what is asked.',
    'verdict "fix" when there is any major issue or any score below 4; otherwise "pass".',
  ].join('\n'),
  user: (c: QuestionsContext, set: string) =>
    `${contextText(c)}\n\nThe questions to review (JSON):\n${set}`,
} as const;

export const QUESTIONS_FIXER_PROMPT = {
  system: [
    QUESTIONS_WRITER_PROMPT.system,
    'You are given a draft and an examiner review. Return the corrected set: fix every major issue and the minor ones that are right; keep what is already correct.',
  ].join('\n'),
  user: (c: QuestionsContext, set: string, issues: string) =>
    `${contextText(c)}\n\nDraft (JSON):\n${set}\n\nExaminer review:\n${issues}`,
} as const;

const PROMPTS = {
  writer: QUESTIONS_WRITER_PROMPT,
  critic: QUESTIONS_CRITIC_PROMPT,
  fixer: QUESTIONS_FIXER_PROMPT,
};

// ------------------------------------------------------------------ duplicates and copies

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export interface Similarity {
  /** Our questions removed as near-duplicates of an earlier one in the set (their text). */
  removed: string[];
  /** Kept questions (1-based) that are near copies of a past question. */
  copies: { q: number; of: string; score: number }[];
}

/** Removes near-duplicates inside the set; flags near copies of past board questions. */
export async function dedupe(
  env: Env,
  set: QuestionSet,
  past: { label: string; text: string }[],
): Promise<{ set: QuestionSet; similarity: Similarity }> {
  const qs = set.questions;
  if (!qs.length) return { set, similarity: { removed: [], copies: [] } };
  const vecs = await embedder(env).embed([
    ...qs.map((q) => q.question),
    ...past.map((p) => p.text),
  ]);
  const mine = vecs.slice(0, qs.length);
  const theirs = vecs.slice(qs.length);
  const keep: number[] = [];
  const removed: string[] = [];
  for (let i = 0; i < qs.length; i++) {
    if (keep.some((k) => cosine(mine[k]!, mine[i]!) >= DUPLICATE)) removed.push(qs[i]!.question);
    else keep.push(i);
  }
  const copies: Similarity['copies'] = [];
  keep.forEach((i, pos) => {
    let best = { score: 0, of: '' };
    theirs.forEach((v, j) => {
      const sc = cosine(mine[i]!, v);
      if (sc > best.score) best = { score: sc, of: past[j]!.label };
    });
    if (best.score >= COPY)
      copies.push({ q: pos + 1, of: best.of, score: Math.round(best.score * 100) / 100 });
  });
  return { set: { questions: keep.map((i) => qs[i]!) }, similarity: { removed, copies } };
}

// ------------------------------------------------------------------ checks

const list = (ns: number[]) => ns.map((n) => `Q${n}`).join(', ');

export function questionChecks(
  set: QuestionSet,
  ctx: Pick<QuestionsContext, 'marks' | 'count' | 'exam' | 'part'>,
  sourceCount: number,
  sim: Similarity,
): AssetCheck[] {
  const qs = set.questions;
  const nums = (f: (q: GeneratedQuestion) => boolean) =>
    qs.map((q, i) => (f(q) ? i + 1 : 0)).filter(Boolean);
  const checks: AssetCheck[] = [];
  checks.push({
    name: 'Number of questions',
    ok: qs.length >= ctx.count - 1 && qs.length <= ctx.count + 1,
    detail: `${qs.length} (asked for ${ctx.count})`,
  });
  const uncited = nums((q) => {
    const n = Number(/S(\d+)/i.exec(q.cite ?? '')?.[1] ?? 0);
    return n < 1 || n > sourceCount;
  });
  checks.push({
    name: 'Every question cites the textbook',
    ok: uncited.length === 0,
    detail: uncited.length ? `no valid citation: ${list(uncited)}` : `${qs.length} cited`,
  });
  const badPoints = nums((q) => {
    const sum = q.markingPoints.reduce((a, p) => a + p.marks, 0);
    const split = q.marksSplit ? splitTotal(q.marksSplit) : null;
    if (ctx.marks === 1) return q.markingPoints.length > 0 && sum !== 1;
    return sum !== ctx.marks || (split !== null && split !== ctx.marks);
  });
  checks.push({
    name: 'Marking points add up',
    ok: badPoints.length === 0,
    detail: badPoints.length
      ? `not ${ctx.marks} marks: ${list(badPoints)}`
      : `each question = ${ctx.marks} mark${ctx.marks === 1 ? '' : 's'}`,
  });
  const mcqs = qs.filter((q) => q.typology === 'mcq');
  if (mcqs.length) {
    const badMcq = nums((q) => {
      if (q.typology !== 'mcq') return false;
      const opts = q.options ?? [];
      const a = q.answer.toLowerCase();
      const hit = opts.filter((o, k) => {
        const letter = String.fromCharCode(97 + k);
        return (
          a.includes(
            o
              .toLowerCase()
              .replace(/^\(?[a-d][).]\s*/, '')
              .trim(),
          ) || new RegExp(`(^|[^a-z])\\(?${letter}\\)`).test(a)
        );
      });
      return opts.length !== 4 || hit.length === 0;
    });
    checks.push({
      name: 'MCQs have 4 options and the answer names one',
      ok: badMcq.length === 0,
      detail: badMcq.length ? list(badMcq) : `${mcqs.length} MCQs`,
    });
  }
  if (ctx.marks >= 6) {
    const tally = qs.flatMap((q, i) => tallyProblems(q.answer).map((p) => `Q${i + 1}: ${p}`));
    checks.push({
      name: 'Accounts and statements tally',
      ok: tally.length === 0,
      detail: tally.length ? tally.slice(0, 3).join('; ') : 'all totals agree',
    });
  }
  const long = nums((q) => words(q.answer) > ctx.exam.maxWords * 1.15);
  checks.push({
    name: `Answers fit ${ctx.exam.minutes} min`,
    ok: long.length === 0,
    detail: long.length
      ? `longer than about ${ctx.exam.maxWords} words: ${list(long)}`
      : `each within about ${ctx.exam.maxWords} words`,
  });
  if (qs.length >= 4) {
    const types = new Set(qs.map((q) => q.typology)).size;
    const levels = new Set(qs.map((q) => q.difficulty)).size;
    checks.push({
      name: 'A mix of question types and difficulty',
      ok: (ctx.part !== 'A' || types >= 3) && levels >= 2,
      detail: `${types} question types, ${levels} difficulty levels`,
    });
  }
  checks.push({
    name: 'No duplicates',
    ok: true,
    detail: sim.removed.length
      ? `removed ${sim.removed.length} near-duplicate${sim.removed.length === 1 ? '' : 's'}`
      : 'none found',
  });
  checks.push({
    name: 'Not copied from past papers',
    ok: sim.copies.length === 0,
    detail: sim.copies.length
      ? sim.copies.map((c) => `Q${c.q} ≈ ${c.of} (${c.score})`).join('; ')
      : 'no near copies',
  });
  return checks;
}

// ------------------------------------------------------------------ generate

const MAX_EXCERPTS = 14;

async function questionsContext(
  env: Env,
  db: Db,
  strategyId: string,
  s: ExamStrategy,
  slot: QuestionSlot,
  tags: string[],
) {
  const ch = s.chapters.find((c) => c.no === slot.chapter);
  const topics = ch?.topics ?? [];
  const found: Source[] = [];
  const seen = new Set<string>();
  for (const q of [
    slot.chapterTitle,
    ...[...topics].sort((a, b) => b.examPapers - a.examPapers).map((t) => t.name),
  ]) {
    if (found.length >= MAX_EXCERPTS) break;
    for (const h of await retrieve(env, db, `${q} (${slot.chapterTitle})`, tags, { topK: 2 }))
      if (!seen.has(h.chunkId) && found.length < MAX_EXCERPTS) {
        seen.add(h.chunkId);
        found.push({ ...h, n: found.length + 1 });
      }
  }
  // Past questions of this chapter at this level: examples for style, and the copy check.
  const past = await db
    .select({
      source: boardItems.source,
      label: boardItems.paperLabel,
      qno: boardItems.qno,
      typology: boardItems.typology,
      text: boardItems.text,
      markSplit: boardItems.markSplit,
      answer: boardItems.answer,
    })
    .from(boardItems)
    .where(
      and(
        eq(boardItems.strategyId, strategyId),
        eq(boardItems.chapter, slot.chapter),
        eq(boardItems.marks, slot.marks),
      ),
    )
    .orderBy(
      sql`case ${boardItems.source} when 'board_exam' then 0 when 'model_paper' then 1 else 2 end`,
    )
    .limit(120);
  const label = (p: (typeof past)[number]) =>
    `${p.source === 'bank' ? 'question bank' : (p.label ?? p.source)} Q${p.qno}`;
  const partInfo = s.parts?.find((p) => p.part === slot.part);
  const part = slot.part === 'C' || slot.part === 'D' ? slot.part : null;
  const ctx: QuestionsContext = {
    board: s.board,
    className: s.className,
    subject: s.subject,
    chapter: slot.chapter,
    chapterTitle: slot.chapterTitle,
    part: slot.part,
    marks: slot.marks,
    count: questionsPerSet(slot.marks),
    exam: examBudget(slot.marks, partInfo?.minutesPerQuestion),
    topics: topics.map((t) => ({ name: t.name, examPapers: t.examPapers, marks: t.marks })),
    typology: s.typologyByPart?.[slot.part] ?? {},
    difficulty: s.difficulty ?? {},
    allowed: part
      ? (ch?.problemSpecs.filter((p) => p.part === part).flatMap((p) => p.allowed) ?? [])
      : [],
    instructions: (partInfo?.instructions ?? []).slice(0, 6),
    examples: past.slice(0, 8).map((p) => ({
      label: label(p),
      typology: p.typology,
      text: p.text,
      markSplit: p.markSplit,
      answer: p.answer,
    })),
    conventions: (s.answerConventions ?? [])
      .slice(0, 12)
      .map((c) => ({ format: c.format, rule: c.rule })),
    excerpts: found.map((f) => ({ n: f.n, page: f.page, section: f.section, text: f.text })),
  };
  const sources: AssetSource[] = found.map((f) => ({
    n: f.n,
    bookId: f.bookId,
    bookTitle: f.bookTitle,
    page: f.page,
    section: f.section,
  }));
  return { ctx, sources, past: past.map((p) => ({ label: label(p), text: p.text })) };
}

const maxTokens = (marks: number) => (marks >= 12 ? 12000 : marks >= 6 ? 10000 : 6000);

async function produce(
  env: Env,
  db: Db,
  o: {
    run: { id: string | null; userId: string; offeringId: string; strategyId: string };
    s: ExamStrategy;
    slot: QuestionSlot;
    tags: string[];
    rewrite?: { from: unknown; comment: string; asset: typeof learningAssets.$inferSelect };
  },
) {
  const { ctx, sources, past } = await questionsContext(
    env,
    db,
    o.run.strategyId,
    o.s,
    o.slot,
    o.tags,
  );
  const out = await writeCritiqueFix(env, db, {
    schema: questionSetSchema,
    prompts: PROMPTS,
    ctx,
    userId: o.run.userId,
    maxTokens: maxTokens(o.slot.marks),
    rewrite: o.rewrite,
  });
  const { set, similarity } = await dedupe(env, out.value, past);
  const id = await saveVersion(db, {
    kind: 'questions',
    promptVersion: QUESTIONS_PROMPT_VERSION,
    run: { id: o.run.id, offeringId: o.run.offeringId, strategyId: o.run.strategyId },
    slot: o.slot,
    content: set,
    critique: out.critique,
    fixed: out.fixed,
    checks: questionChecks(set, ctx, sources.length, similarity),
    sources,
    cost: out.cost,
    reject:
      o.rewrite && o.rewrite.asset.status === 'draft'
        ? { id: o.rewrite.asset.id, comment: o.rewrite.comment, by: o.run.userId }
        : undefined,
  });
  return { id, cost: out.cost };
}

/** Writes one question set (chapter × marks level) as a new draft version. Returns its cost. */
export async function generateQuestions(
  env: Env,
  db: Db,
  run: { id: string; userId: string; offeringId: string; strategyId: string },
  s: ExamStrategy,
  slot: QuestionSlot,
  tags: string[],
) {
  return (await produce(env, db, { run, s, slot, tags })).cost;
}

/** "Rewrite with my comment" for a question set. */
export async function rewriteQuestions(
  env: Env,
  db: Db,
  asset: typeof learningAssets.$inferSelect,
  comment: string,
  userId: string,
) {
  const s = await strategyOf(db, asset.strategyId);
  const tags = await textbookTags(db, asset.offeringId);
  if (!tags.length) throw new Error('No published textbook for this subject');
  const slot =
    planQuestionSlots(s, [asset.chapter]).find((x) => x.key === asset.slotKey) ??
    ({
      key: asset.slotKey,
      chapter: asset.chapter,
      chapterTitle: asset.topic,
      topic: asset.topic,
      marks: asset.marks,
      part: (Object.entries(PART_MARKS).find(([, m]) => m === asset.marks)?.[0] ?? 'A') as Part,
    } satisfies QuestionSlot);
  const { id } = await produce(env, db, {
    run: { id: null, userId, offeringId: asset.offeringId, strategyId: asset.strategyId! },
    s,
    slot,
    tags,
    rewrite: { from: asset.content, comment, asset },
  });
  return id;
}
