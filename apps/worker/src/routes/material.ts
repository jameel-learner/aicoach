import { ASSET_KINDS, marksTarget, subjectMap, type ExamStrategy } from '@aicoach/core';
import { generationRuns, learningAssets, type Db } from '@aicoach/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { planGraphSlot } from '../assets/graph';
import { planQuestionSlots } from '../assets/questions';
import { reviewsOf, teacherScoresByAsset, teacherStats } from '../assets/reviews';
import { importMaterial, publishMaterial, sharedMaterial } from '../assets/share';
import {
  approvedStrategy,
  latestAssets,
  planSlots,
  rewriteNote,
  runGenerate,
} from '../assets/generate';
import { inlineSteps } from '../content/ingest';
import type { AppBindings, Env } from '../env';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound, parseBody } from '../lib/http';
import { getModels, getTaskConfig } from '../llm/registry';
import { requireAuth, requireRole } from '../middleware/session';
import { PROCESS_ON_LOCAL, processingEnabled } from './books';

/**
 * Admin: learning material (architecture §7 Phase 3, decision 9.5-4). Generate notes from the
 * approved strategy (LOCAL), review each (critic scores + code checks), approve or reject.
 */
export const materialRoutes = new Hono<AppBindings>();
materialRoutes.use('*', requireAuth, requireRole('admin'));

const STALL_MS = 10 * 60_000;
/**
 * Tokens per asset for the estimate (writer + critic + a fixer about half the time):
 * a note by marks level, a chapter's cards, a question set by marks level.
 */
const NOTE_OUT: Record<number, number> = { 1: 400, 2: 650, 6: 1900, 12: 3300 };
const QUESTIONS_OUT: Record<number, number> = { 1: 2200, 2: 1800, 6: 4500, 12: 6500 };
type Job = { ctx: number; out: number };
const noteJob = (marks: number): Job => ({ ctx: 6500, out: NOTE_OUT[marks] ?? 1000 });
const CARDS_JOB: Job = { ctx: 11000, out: 4500 };
const questionsJob = (marks: number): Job => ({ ctx: 9000, out: QUESTIONS_OUT[marks] ?? 3000 });
const GRAPH_JOB: Job = { ctx: 9000, out: 6000 };
/** Gemini 2.5 Flash list prices, used when a model has no synced price. */
const FALLBACK = { in: 0.3e-6, out: 2.5e-6 };

async function estimate(db: Db, jobs: Job[]) {
  const [writer, critic] = await Promise.all([
    getTaskConfig(db, 'content_generation'),
    getTaskConfig(db, 'content_review'),
  ]);
  const priced = await getModels(db, [writer.primaryModel, critic.primaryModel]);
  const price = (id: string) => {
    const m = priced.find((p) => p.id === id);
    return {
      in: m?.pricePromptPico ? m.pricePromptPico / 1e12 : FALLBACK.in,
      out: m?.priceCompletionPico ? m.priceCompletionPico / 1e12 : FALLBACK.out,
    };
  };
  const w = price(writer.primaryModel);
  const c = price(critic.primaryModel);
  let usd = 0;
  for (const { ctx, out } of jobs) {
    const writerCall = ctx * w.in + out * w.out;
    const criticCall = (ctx + out) * c.in + 600 * c.out;
    const fixerCall = (ctx + out + 600) * w.in + out * w.out;
    usd += writerCall + criticCall + 0.5 * fixerCall;
  }
  return {
    usd: Math.round(usd * 100) / 100,
    writer: writer.primaryModel,
    critic: critic.primaryModel,
  };
}

const offeringQuery = z.object({ offeringId: z.string().min(1) });

materialRoutes.get('/', async (c) => {
  const { offeringId } = offeringQuery.parse({ offeringId: c.req.query('offeringId') });
  const { db } = c.var;
  const strat = await approvedStrategy(db, offeringId);
  const s = strat?.strategy as ExamStrategy | undefined;
  const slots = s ? planSlots(s, null) : [];
  const assets = await latestAssets(db, offeringId);
  const cardAssets = await latestAssets(db, offeringId, undefined, 'cards');
  const cardsEstimate = (await estimate(db, [CARDS_JOB])).usd;
  const qSlots = s ? planQuestionSlots(s, null) : [];
  const qAssets = await latestAssets(db, offeringId, undefined, 'questions');
  const graphAssets = await latestAssets(db, offeringId, 0, 'graph');
  const runs = await db
    .select()
    .from(generationRuns)
    .where(eq(generationRuns.offeringId, offeringId))
    .orderBy(desc(generationRuns.createdAt))
    .limit(20);
  const chapters = (s?.chapters ?? []).map((ch) => {
    const inCh = slots.filter((x) => x.chapter === ch.no);
    const a = assets.filter((x) => x.chapter === ch.no);
    return {
      no: ch.no,
      title: ch.title,
      notes: inCh.length,
      generated: a.length,
      approved: a.filter((x) => x.status === 'approved').length,
      rejected: a.filter((x) => x.status === 'rejected').length,
      estimateLevels: inCh.map((x) => x.marks),
      cards: {
        status:
          cardAssets.find((x) => x.chapter === ch.no && x.status !== 'approved')?.status ??
          cardAssets.find((x) => x.chapter === ch.no)?.status ??
          null,
        approved: cardAssets.some((x) => x.chapter === ch.no && x.status === 'approved'),
        estimateUsd: cardsEstimate,
      },
      questions: {
        sets: qSlots.filter((x) => x.chapter === ch.no).map((x) => x.marks),
        generated: new Set(qAssets.filter((x) => x.chapter === ch.no).map((x) => x.slotKey)).size,
        approved: qAssets.filter((x) => x.chapter === ch.no && x.status === 'approved').length,
        estimateUsd: 0,
      },
    };
  });
  return c.json({
    processingEnabled: processingEnabled(c.env),
    strategy: strat ? { id: strat.id, version: strat.version } : null,
    chapters: await Promise.all(
      chapters.map(async (ch) => ({
        ...ch,
        estimateLevels: undefined,
        estimateUsd: (await estimate(db, ch.estimateLevels.map(noteJob))).usd,
        questions: {
          ...ch.questions,
          estimateUsd: (await estimate(db, ch.questions.sets.map(questionsJob))).usd,
        },
      })),
    ),
    estimate: await estimate(
      db,
      slots.map((x) => noteJob(x.marks)),
    ),
    graph: s
      ? {
          slotKey: planGraphSlot(s).key,
          status:
            graphAssets.find((x) => x.status !== 'approved')?.status ??
            graphAssets[0]?.status ??
            null,
          approved: graphAssets.some((x) => x.status === 'approved'),
          estimateUsd: (await estimate(db, [GRAPH_JOB])).usd,
        }
      : null,
    runs: runs.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      statusMessage: r.statusMessage,
      chapters: r.chapters,
      costUsdNano: r.costUsdNano,
      createdAt: r.createdAt,
      progress: r.progress ? { ...r.progress, checkpoints: undefined } : null,
      stalled: r.status === 'running' && Date.now() - r.updatedAt.getTime() > STALL_MS,
    })),
  });
});

async function start(env: Env, db: Db, runId: string, userId: string) {
  if (env.APP_ENV === 'test') {
    await runGenerate(env, db, { runId, userId }, inlineSteps).catch(() => undefined);
    return null;
  }
  if (!env.GENERATE_ASSETS)
    throw badRequest(
      env.INGEST_BOOK
        ? 'Generating needs a restart of the local server (pnpm dev:worker) to load its workflow.'
        : PROCESS_ON_LOCAL,
    );
  const instance = await env.GENERATE_ASSETS.create({ params: { runId, userId } });
  await db
    .update(generationRuns)
    .set({ workflowId: instance.id })
    .where(eq(generationRuns.id, runId));
  return instance.id;
}

const generateSchema = z.object({
  offeringId: z.string().min(1),
  kind: z.enum(ASSET_KINDS).default('note'),
  chapters: z.array(z.coerce.number().int().positive()).max(40).optional(),
});

materialRoutes.post('/generate', async (c) => {
  const { db, user: me } = c.var;
  if (!processingEnabled(c.env)) throw badRequest(PROCESS_ON_LOCAL);
  const { offeringId, chapters, kind } = await parseBody(c, generateSchema);
  const strat = await approvedStrategy(db, offeringId);
  if (!strat) throw badRequest('Approve an exam strategy for this subject first');
  const running = await db
    .select({ updatedAt: generationRuns.updatedAt })
    .from(generationRuns)
    .where(and(eq(generationRuns.offeringId, offeringId), eq(generationRuns.status, 'running')));
  if (running.some((r) => Date.now() - r.updatedAt.getTime() <= STALL_MS))
    throw conflict('Material is already being generated for this subject');
  const row = await db
    .insert(generationRuns)
    .values({
      offeringId,
      strategyId: strat.id,
      kind,
      chapters: chapters?.length ? chapters : null,
      createdBy: me.id,
    })
    .returning({ id: generationRuns.id })
    .get();
  await audit(db, me.id, 'generate_material', 'generation_run', row.id, {
    offeringId,
    kind,
    chapters,
  });
  const workflowId = await start(c.env, db, row.id, me.id);
  return c.json({ id: row.id, workflowId }, 202);
});

/** Continue a stopped or failed run: notes already written are skipped (not paid again). */
materialRoutes.post('/runs/:id/continue', async (c) => {
  const { db, user: me } = c.var;
  if (!processingEnabled(c.env)) throw badRequest(PROCESS_ON_LOCAL);
  const run = await db
    .select()
    .from(generationRuns)
    .where(eq(generationRuns.id, c.req.param('id')))
    .get();
  if (!run) throw notFound('Generation run');
  const stalled = run.status === 'running' && Date.now() - run.updatedAt.getTime() > STALL_MS;
  if (run.status !== 'failed' && !stalled)
    throw conflict('Only a stopped or failed run can be continued');
  await db
    .update(generationRuns)
    .set({ status: 'running', statusMessage: null, updatedAt: new Date() })
    .where(eq(generationRuns.id, run.id));
  const workflowId = await start(c.env, db, run.id, me.id);
  return c.json({ ok: true, workflowId }, 202);
});

materialRoutes.get('/assets', async (c) => {
  const { offeringId } = offeringQuery.parse({ offeringId: c.req.query('offeringId') });
  const chapter = c.req.query('chapter') ? Number(c.req.query('chapter')) : undefined;
  const kind = z
    .enum(ASSET_KINDS)
    .default('note')
    .parse(c.req.query('kind') || undefined);
  const rows = await latestAssets(c.var.db, offeringId, chapter, kind);
  const scores = await teacherScoresByAsset(
    c.var.db,
    rows.map((r) => r.id),
  );
  return c.json(rows.map((r) => ({ ...r, teacherReviews: scores.get(r.id) ?? null })));
});

/**
 * Moving approved material between environments (decision 9.5-7): publish on LOCAL (where it is
 * generated), import elsewhere. Neither makes a model call.
 */
materialRoutes.get('/shared', async (c) => {
  const { offeringId } = offeringQuery.parse({ offeringId: c.req.query('offeringId') });
  return c.json({
    canPublish: processingEnabled(c.env),
    package: await sharedMaterial(c.env, c.var.db, offeringId),
  });
});

materialRoutes.post('/publish', async (c) => {
  if (!processingEnabled(c.env))
    throw badRequest('Publish material from local, then import it here.');
  const { offeringId } = await parseBody(c, offeringQuery);
  return c.json(await publishMaterial(c.env, c.var.db, offeringId, c.var.user.id));
});

materialRoutes.post('/import', async (c) => {
  const { offeringId } = await parseBody(c, offeringQuery);
  return c.json(await importMaterial(c.env, c.var.db, offeringId, c.var.user.id));
});

/** Subject-wise memory map (spec 2.4): built by code from the approved strategy, no model call. */
materialRoutes.get('/subject-map', async (c) => {
  const { offeringId } = offeringQuery.parse({ offeringId: c.req.query('offeringId') });
  const strat = await approvedStrategy(c.var.db, offeringId);
  if (!strat?.strategy) throw notFound('Approved strategy');
  return c.json(subjectMap(strat.strategy as ExamStrategy));
});

materialRoutes.get('/assets/:id', async (c) => {
  const row = await c.var.db
    .select()
    .from(learningAssets)
    .where(eq(learningAssets.id, c.req.param('id')))
    .get();
  if (!row) throw notFound('Learning asset');
  return c.json({
    ...row,
    target: marksTarget(row.marks),
    reviews: await reviewsOf(c.var.db, row.id),
  });
});

/** Every version of this note's slot, newest first (older drafts stay for comparison). */
materialRoutes.get('/assets/:id/versions', async (c) => {
  const { db } = c.var;
  const row = await db
    .select({ slotKey: learningAssets.slotKey, offeringId: learningAssets.offeringId })
    .from(learningAssets)
    .where(eq(learningAssets.id, c.req.param('id')))
    .get();
  if (!row) throw notFound('Learning asset');
  const versions = await db
    .select({
      id: learningAssets.id,
      version: learningAssets.version,
      status: learningAssets.status,
      generator: learningAssets.generator,
      critique: learningAssets.critique,
      fixed: learningAssets.fixed,
      reviewScore: learningAssets.reviewScore,
      costUsdNano: learningAssets.costUsdNano,
      createdAt: learningAssets.createdAt,
    })
    .from(learningAssets)
    .where(
      and(eq(learningAssets.slotKey, row.slotKey), eq(learningAssets.offeringId, row.offeringId)),
    )
    .orderBy(desc(learningAssets.version));
  return c.json(versions);
});

const reviewSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    /** Reviewer's rubric score (Phase 3 exit: ≥ 4 on a sample). */
    score: z.coerce.number().int().min(1).max(5).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.decision === 'approve' || !!v.note, 'Say why you reject it');

/** Approve (becomes what learners see; the slot's previous approved version is superseded) or reject. */
materialRoutes.post('/assets/:id/review', async (c) => {
  const { db, user: me } = c.var;
  const v = await parseBody(c, reviewSchema);
  const row = await db
    .select()
    .from(learningAssets)
    .where(eq(learningAssets.id, c.req.param('id')))
    .get();
  if (!row) throw notFound('Learning asset');
  if (row.status !== 'draft') throw conflict('Only a draft can be reviewed');
  const reviewed = {
    reviewScore: v.score ?? null,
    reviewNote: v.note ?? null,
    reviewedBy: me.id,
    reviewedAt: new Date(),
    updatedAt: new Date(),
  };
  if (v.decision === 'approve')
    await db.batch([
      db
        .update(learningAssets)
        .set({ status: 'superseded', updatedAt: new Date() })
        .where(and(eq(learningAssets.slotKey, row.slotKey), eq(learningAssets.status, 'approved'))),
      db
        .update(learningAssets)
        .set({ ...reviewed, status: 'approved' })
        .where(eq(learningAssets.id, row.id)),
    ]);
  else
    await db
      .update(learningAssets)
      .set({ ...reviewed, status: 'rejected' })
      .where(eq(learningAssets.id, row.id));
  await audit(db, me.id, `${v.decision}_learning_asset`, 'learning_asset', row.id, {
    slot: row.slotKey,
    version: row.version,
    score: v.score,
  });
  return c.json({ ok: true });
});

const rewriteSchema = z.object({ note: z.string().trim().min(3).max(1000) });

/**
 * "Rewrite with my comment" (LOCAL): the fixer rewrites the note following the reviewer's comment,
 * the critic and the checks run again, and it becomes the slot's next draft. The draft it replaces
 * is marked rejected with the comment. Only the newest version of a slot (draft or rejected).
 */
materialRoutes.post('/assets/:id/rewrite', async (c) => {
  const { db, user: me } = c.var;
  if (!processingEnabled(c.env)) throw badRequest(PROCESS_ON_LOCAL);
  const { note } = await parseBody(c, rewriteSchema);
  const row = await db
    .select()
    .from(learningAssets)
    .where(eq(learningAssets.id, c.req.param('id')))
    .get();
  if (!row) throw notFound('Learning asset');
  if (row.status !== 'draft' && row.status !== 'rejected')
    throw conflict('Only a draft or a rejected note can be rewritten');
  const newest = await db
    .select({ v: sql<number>`max(${learningAssets.version})` })
    .from(learningAssets)
    .where(
      and(eq(learningAssets.slotKey, row.slotKey), eq(learningAssets.offeringId, row.offeringId)),
    )
    .get();
  if (Number(newest?.v) !== row.version)
    throw conflict('A newer version of this note exists: rewrite that one');
  const id = await rewriteNote(c.env, db, row, note, me.id);
  await audit(db, me.id, 'rewrite_learning_asset', 'learning_asset', row.id, {
    slot: row.slotKey,
    version: row.version,
    newId: id,
  });
  return c.json({ id }, 201);
});

/** Reviewer scores so far (Phase 3 exit criterion: teacher rubric ≥ 4/5 on a sample). */
materialRoutes.get('/review-summary', async (c) => {
  const { offeringId } = offeringQuery.parse({ offeringId: c.req.query('offeringId') });
  const r = await c.var.db
    .select({
      reviewed: sql<number>`count(${learningAssets.reviewScore})`,
      avg: sql<number | null>`avg(${learningAssets.reviewScore})`,
    })
    .from(learningAssets)
    .where(eq(learningAssets.offeringId, offeringId))
    .get();
  return c.json({
    reviewed: Number(r?.reviewed ?? 0),
    averageScore: r?.avg ?? null,
    teachers: await teacherStats(c.var.db, offeringId),
  });
});
