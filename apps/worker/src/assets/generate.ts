import {
  critiqueSchema,
  examBudget,
  marksTarget,
  noteDraftSchema,
  slotKey,
  type AssetKind,
  type AssetSource,
  type ExamStrategy,
  type NoteDraft,
} from '@aicoach/core';
import { boardItems, examStrategies, generationRuns, learningAssets, type Db } from '@aicoach/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { StepRunner } from '../content/ingest';
import { retrieve } from '../content/retrieve';
import { InsufficientCredits } from '../credits/ledger';
import { platformWallet } from '../credits/wallets';
import type { Env } from '../env';
import { askJson } from '../llm/json';
import { noteChecks } from './checks';
import { generateCards, planCardSlots, rewriteCards, type CardSlot } from './cards';
import { generateGraph, planGraphSlot, rewriteGraph } from './graph';
import type { SlotRef } from './shared';
import {
  generateQuestions,
  planQuestionSlots,
  rewriteQuestions,
  type QuestionSlot,
} from './questions';
import { needsFix, reviewerIssue, saveVersion, textbookTags } from './shared';
import {
  ASSET_PROMPT_VERSION,
  CRITIC_PROMPT,
  FIXER_PROMPT,
  WRITER_PROMPT,
  type NoteContext,
} from './prompts';

/**
 * GenerateAssets (architecture §7 Phase 3, decision 9.5-4): notes per topic × marks level from the
 * APPROVED exam strategy. Per slot: context (textbook excerpts, past board questions + marks
 * allotment, allowed problem types, presentation rules) → writer → critic → fixer (only when the
 * critic asks for it) → code checks → new draft version. Finished slots are checkpointed, so
 * continuing a stopped run never pays twice.
 */

export interface GenerateParams {
  runId: string;
  userId: string;
}

export interface Slot {
  key: string;
  chapter: number;
  chapterTitle: string;
  topic: string;
  marks: number;
}

/** One note per topic and marks level (1, 2, 6, 12) it is asked at; topics never asked get a 1-mark note. */
export function planSlots(s: ExamStrategy, chapters: number[] | null): Slot[] {
  const out: Slot[] = [];
  for (const c of s.chapters) {
    if (chapters && !chapters.includes(c.no)) continue;
    for (const t of c.topics) {
      const levels = [
        ...new Set((t.marks.length ? t.marks : [1]).map((m) => marksTarget(m).level)),
      ];
      for (const m of levels.sort((a, b) => a - b))
        out.push({
          key: slotKey('note', c.no, t.name, m),
          chapter: c.no,
          chapterTitle: c.title,
          topic: t.name,
          marks: m,
        });
    }
  }
  return out;
}

/** The approved strategy for an offering (learning material follows only an approved one). */
export async function approvedStrategy(db: Db, offeringId: string) {
  return db
    .select()
    .from(examStrategies)
    .where(and(eq(examStrategies.offeringId, offeringId), eq(examStrategies.status, 'approved')))
    .orderBy(desc(examStrategies.version))
    .get();
}

async function contextFor(
  env: Env,
  db: Db,
  strategyId: string,
  s: ExamStrategy,
  slot: Slot,
  tags: string[],
): Promise<{ ctx: NoteContext; sources: AssetSource[] }> {
  const target = marksTarget(slot.marks);
  // Time per question at this marks level, from the paper pattern (e.g. Part C: 13.5 min).
  const part = s.parts?.find((p) => p.marksEach === slot.marks);
  const exam = examBudget(slot.marks, part?.minutesPerQuestion);
  const found = await retrieve(env, db, `${slot.topic} (${slot.chapterTitle})`, tags, { topK: 6 });
  const examples = await db
    .select({
      source: boardItems.source,
      label: boardItems.paperLabel,
      marks: boardItems.marks,
      text: boardItems.text,
      markSplit: boardItems.markSplit,
      answer: boardItems.answer,
    })
    .from(boardItems)
    .where(
      and(
        eq(boardItems.strategyId, strategyId),
        eq(boardItems.chapter, slot.chapter),
        eq(boardItems.topicGroup, slot.topic),
      ),
    )
    .orderBy(
      sql`case ${boardItems.source} when 'board_exam' then 0 when 'model_paper' then 1 else 2 end`,
      sql`abs(coalesce(${boardItems.marks}, 0) - ${slot.marks})`,
    )
    .limit(5);
  const chapter = s.chapters.find((c) => c.no === slot.chapter);
  const specPart = slot.marks >= 12 ? 'D' : slot.marks >= 6 ? 'C' : null;
  return {
    ctx: {
      board: s.board,
      className: s.className,
      subject: s.subject,
      chapter: slot.chapter,
      chapterTitle: slot.chapterTitle,
      topic: slot.topic,
      marks: slot.marks,
      target,
      exam,
      allowed: specPart
        ? (chapter?.problemSpecs.filter((p) => p.part === specPart).flatMap((p) => p.allowed) ?? [])
        : [],
      examples: examples.map((e) => ({
        label: e.source === 'bank' ? 'question bank' : (e.label ?? e.source),
        marks: e.marks,
        text: e.text,
        markSplit: e.markSplit,
        answer: e.answer,
      })),
      conventions: s.answerConventions.map((c) => ({ format: c.format, rule: c.rule })),
      excerpts: found.map((f) => ({ n: f.n, page: f.page, section: f.section, text: f.text })),
    },
    sources: found.map((f) => ({
      n: f.n,
      bookId: f.bookId,
      bookTitle: f.bookTitle,
      page: f.page,
      section: f.section,
    })),
  };
}

/** Writes one note into its slot as a new draft version. Returns its cost (nano-USD). */
export async function generateNote(
  env: Env,
  db: Db,
  run: { id: string; userId: string; offeringId: string; strategyId: string },
  s: ExamStrategy,
  slot: Slot,
  tags: string[],
) {
  const payers = [await platformWallet(db)];
  const { ctx, sources } = await contextFor(env, db, run.strategyId, s, slot, tags);
  const maxTokens = slot.marks >= 12 ? 9000 : slot.marks >= 6 ? 6000 : 2500;
  const common = { payers, userId: run.userId, thinking: 'off' as const };

  const draft = await askJson(env, db, {
    ...common,
    task: 'content_generation',
    schema: noteDraftSchema,
    system: WRITER_PROMPT.system,
    user: WRITER_PROMPT.user(ctx),
    maxTokens,
  });
  const review = await askJson(env, db, {
    ...common,
    task: 'content_review',
    schema: critiqueSchema,
    system: CRITIC_PROMPT.system,
    user: CRITIC_PROMPT.user(ctx, JSON.stringify(draft.value)),
    maxTokens: 2500,
  });
  let note: NoteDraft = draft.value;
  let cost = draft.costUsdNano + review.costUsdNano;
  const fixed = needsFix(review.value);
  if (fixed) {
    const fix = await askJson(env, db, {
      ...common,
      task: 'content_generation',
      schema: noteDraftSchema,
      system: FIXER_PROMPT.system,
      user: FIXER_PROMPT.user(ctx, JSON.stringify(draft.value), JSON.stringify(review.value)),
      maxTokens,
    });
    note = fix.value;
    cost += fix.costUsdNano;
  }

  await saveVersion(db, {
    run: { id: run.id, offeringId: run.offeringId, strategyId: run.strategyId },
    slot,
    kind: 'note',
    promptVersion: ASSET_PROMPT_VERSION,
    content: note,
    critique: { ...review.value, fixedAfter: fixed },
    fixed,
    checks: noteChecks(note, slot.marks, sources.length, ctx.exam),
    sources,
    cost,
  });
  return cost;
}

/**
 * Reviewer's "rewrite with my comment": the fixer gets the note and the comment as an examiner
 * issue, the critic scores the result (no further fix), the checks run, and it becomes the slot's
 * next draft. The draft that was rewritten is marked rejected with the comment.
 */
export async function rewriteNote(
  env: Env,
  db: Db,
  asset: typeof learningAssets.$inferSelect,
  comment: string,
  userId: string,
): Promise<string> {
  if (asset.kind === 'cards') return rewriteCards(env, db, asset, comment, userId);
  if (asset.kind === 'questions') return rewriteQuestions(env, db, asset, comment, userId);
  if (asset.kind === 'graph') return rewriteGraph(env, db, asset, comment, userId);
  if (!asset.strategyId) throw new Error('This note has no strategy to follow');
  const strat = await db
    .select()
    .from(examStrategies)
    .where(eq(examStrategies.id, asset.strategyId))
    .get();
  if (!strat?.strategy) throw new Error('The strategy this note follows has no content');
  const s = strat.strategy as ExamStrategy;
  const tags = await textbookTags(db, asset.offeringId);
  if (!tags.length) throw new Error('No published textbook for this subject');
  const slot: Slot = {
    key: asset.slotKey,
    chapter: asset.chapter,
    chapterTitle: s.chapters.find((c) => c.no === asset.chapter)?.title ?? '',
    topic: asset.topic,
    marks: asset.marks,
  };
  const payers = [await platformWallet(db)];
  const { ctx, sources } = await contextFor(env, db, asset.strategyId, s, slot, tags);
  const common = { payers, userId, thinking: 'off' as const };
  const maxTokens = slot.marks >= 12 ? 9000 : slot.marks >= 6 ? 6000 : 2500;
  const fix = await askJson(env, db, {
    ...common,
    task: 'content_generation',
    schema: noteDraftSchema,
    system: FIXER_PROMPT.system,
    user: FIXER_PROMPT.user(ctx, JSON.stringify(asset.content), reviewerIssue(comment)),
    maxTokens,
  });
  const review = await askJson(env, db, {
    ...common,
    task: 'content_review',
    schema: critiqueSchema,
    system: CRITIC_PROMPT.system,
    user: CRITIC_PROMPT.user(ctx, JSON.stringify(fix.value)),
    maxTokens: 2500,
  });
  return saveVersion(db, {
    run: { id: null, offeringId: asset.offeringId, strategyId: asset.strategyId },
    slot,
    kind: 'note',
    promptVersion: ASSET_PROMPT_VERSION,
    content: fix.value,
    critique: { ...review.value, fixedAfter: false },
    fixed: true,
    checks: noteChecks(fix.value, slot.marks, sources.length, ctx.exam),
    sources,
    cost: fix.costUsdNano + review.costUsdNano,
    reject: asset.status === 'draft' ? { id: asset.id, comment, by: userId } : undefined,
  });
}

// ------------------------------------------------------------------ the run

async function readProgress(db: Db, id: string) {
  const row = await db
    .select({ progress: generationRuns.progress })
    .from(generationRuns)
    .where(eq(generationRuns.id, id))
    .get();
  return (row?.progress ?? {}) as { checkpoints?: Record<string, unknown> } & Record<
    string,
    unknown
  >;
}

async function setProgress(db: Db, id: string, values: Record<string, unknown>) {
  const cur = await readProgress(db, id);
  await db
    .update(generationRuns)
    .set({ progress: { ...cur, ...values }, updatedAt: new Date() })
    .where(eq(generationRuns.id, id));
}

export async function runGenerate(env: Env, db: Db, p: GenerateParams, step: StepRunner) {
  const fail = (msg: string) =>
    db
      .update(generationRuns)
      .set({ status: 'failed', statusMessage: msg.slice(0, 500), updatedAt: new Date() })
      .where(eq(generationRuns.id, p.runId));
  try {
    const run = await db.select().from(generationRuns).where(eq(generationRuns.id, p.runId)).get();
    if (!run) throw new Error('Generation run not found');
    const strat = await db
      .select()
      .from(examStrategies)
      .where(eq(examStrategies.id, run.strategyId))
      .get();
    if (!strat?.strategy) throw new Error('The strategy this run follows has no content');
    const s = strat.strategy as ExamStrategy;
    const tags = await textbookTags(db, run.offeringId);
    if (!tags.length) throw new Error('No published textbook for this subject');
    const chapters = run.chapters ?? null;
    const slots: (Slot | CardSlot | QuestionSlot | SlotRef)[] =
      run.kind === 'graph'
        ? [planGraphSlot(s)]
        : run.kind === 'cards'
          ? planCardSlots(s, chapters)
          : run.kind === 'questions'
            ? planQuestionSlots(s, chapters)
            : planSlots(s, chapters);
    const ctx = {
      id: run.id,
      userId: p.userId,
      offeringId: run.offeringId,
      strategyId: run.strategyId,
    };

    for (const [i, slot] of slots.entries()) {
      await setProgress(db, run.id, {
        done: i,
        total: slots.length,
        label:
          run.kind === 'graph'
            ? 'Concept graph'
            : run.kind === 'cards'
              ? `Ch ${slot.chapter} · cards and memory map`
              : run.kind === 'questions'
                ? `Ch ${slot.chapter} · ${slot.marks}-mark questions`
                : `Ch ${slot.chapter} · ${slot.topic} · ${slot.marks} mark${slot.marks === 1 ? '' : 's'}`,
      });
      const done = (await readProgress(db, run.id)).checkpoints ?? {};
      if (slot.key in done) continue;
      const cost = await step.do(`${run.kind} ${slot.key}`, () =>
        run.kind === 'graph'
          ? generateGraph(env, db, ctx, s)
          : run.kind === 'cards'
            ? generateCards(env, db, ctx, s, slot as CardSlot, tags)
            : run.kind === 'questions'
              ? generateQuestions(env, db, ctx, s, slot as QuestionSlot, tags)
              : generateNote(env, db, ctx, s, slot as Slot, tags),
      );
      await db
        .update(generationRuns)
        .set({ costUsdNano: sql`${generationRuns.costUsdNano} + ${cost}` })
        .where(eq(generationRuns.id, run.id));
      const cur = await readProgress(db, run.id);
      await setProgress(db, run.id, {
        checkpoints: { ...(cur.checkpoints ?? {}), [slot.key]: cost },
      });
    }
    await setProgress(db, run.id, { done: slots.length, total: slots.length, label: 'Done' });
    await db
      .update(generationRuns)
      .set({ status: 'done', statusMessage: null, updatedAt: new Date() })
      .where(eq(generationRuns.id, run.id));
  } catch (err) {
    await fail(
      err instanceof InsufficientCredits
        ? 'The platform wallet ran out of credits. Issue platform credits, then continue.'
        : `Stopped: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Notes in an offering's slots (for the review list): the newest version of each slot, and the
 * approved one when a newer draft waits for review. Older versions: GET .../assets/:id/versions.
 */
export async function latestAssets(
  db: Db,
  offeringId: string,
  chapter?: number,
  kind: AssetKind = 'note',
) {
  const conds = [
    eq(learningAssets.offeringId, offeringId),
    eq(learningAssets.kind, kind),
    sql`${learningAssets.status} != 'superseded'`,
    sql`(${learningAssets.status} = 'approved' OR ${learningAssets.version} = (SELECT max(la2.version) FROM learning_assets la2 WHERE la2.slot_key = ${learningAssets.slotKey} AND la2.offering_id = ${learningAssets.offeringId}))`,
  ];
  if (chapter) conds.push(eq(learningAssets.chapter, chapter));
  return db
    .select({
      id: learningAssets.id,
      slotKey: learningAssets.slotKey,
      kind: learningAssets.kind,
      version: learningAssets.version,
      chapter: learningAssets.chapter,
      topic: learningAssets.topic,
      marks: learningAssets.marks,
      status: learningAssets.status,
      checks: learningAssets.checks,
      critique: learningAssets.critique,
      fixed: learningAssets.fixed,
      generator: learningAssets.generator,
      reviewScore: learningAssets.reviewScore,
      costUsdNano: learningAssets.costUsdNano,
    })
    .from(learningAssets)
    .where(and(...conds))
    .orderBy(learningAssets.chapter, learningAssets.topic, learningAssets.marks);
}
