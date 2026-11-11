import { boardItems, bookPages, books, examStrategies, type Db } from '@aicoach/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { inlineSteps } from '../content/ingest';
import type { AppBindings, Env } from '../env';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound, parseBody } from '../lib/http';
import { requireAuth, requireRole } from '../middleware/session';
import { assembleRun, runCompile, type CompileParams } from '../strategy/compile';
import { STRATEGY_PROMPT_VERSION } from '../strategy/prompts';
import { PROCESS_ON_LOCAL, processingEnabled } from './books';

/**
 * Admin: exam strategy (architecture §3.5, decision 9.5-2). Compiled on LOCAL from the published
 * board material of a subject offering → draft → Admin approves (one approved version per offering).
 */
export const strategyRoutes = new Hono<AppBindings>();
strategyRoutes.use('*', requireAuth, requireRole('admin'));

const STALL_MS = 10 * 60_000;
/** gemini-2.5-flash list prices (US$ per token); the real cost is shown as the run goes. */
const PRICE_IN = 0.3e-6;
const PRICE_OUT = 2.5e-6;

const offeringQuery = z.object({ offeringId: z.string().min(1) });

async function boardDocs(db: Db, offeringId: string) {
  return db
    .select({
      id: books.id,
      title: books.title,
      category: books.category,
      academicYear: books.academicYear,
      pageCount: books.pageCount,
    })
    .from(books)
    .where(
      and(
        eq(books.offeringId, offeringId),
        eq(books.kind, 'board_material'),
        sql`${books.publishedVersion} IS NOT NULL`,
      ),
    );
}

/**
 * Rough cost. Calibrated on the first real compile (2026-11-11: 732k characters → 365k input and
 * 377k output tokens, US$1.04): input ≈ chars/4 + ~180k of prompts and context, output ≈ input.
 */
async function estimate(db: Db, ids: string[]) {
  if (!ids.length) return { usd: 0, inputTokens: 0 };
  const r = await db
    .select({ chars: sql<number>`coalesce(sum(length(${bookPages.markdown})), 0)` })
    .from(bookPages)
    .where(inArray(bookPages.bookId, ids.slice(0, 90)))
    .get();
  const input = Math.round(Number(r?.chars ?? 0) / 4) + 180_000;
  const usd = input * PRICE_IN + input * 1.0 * PRICE_OUT;
  return { usd: Math.round(usd * 100) / 100, inputTokens: input };
}

const isStalled = (r: typeof examStrategies.$inferSelect) =>
  r.status === 'compiling' && Date.now() - r.updatedAt.getTime() > STALL_MS;

async function start(env: Env, db: Db, p: CompileParams) {
  if (env.APP_ENV === 'test') {
    // Tests run it inline (no Workflow); failures are recorded on the run.
    await runCompile(env, db, p, inlineSteps).catch(() => undefined);
    return null;
  }
  if (!env.COMPILE_STRATEGY)
    throw badRequest(
      env.INGEST_BOOK
        ? 'Strategy compiling needs a restart of the local server (pnpm dev:worker) to load its workflow.'
        : PROCESS_ON_LOCAL,
    );
  const instance = await env.COMPILE_STRATEGY.create({ params: p });
  await db
    .update(examStrategies)
    .set({ workflowId: instance.id })
    .where(eq(examStrategies.id, p.strategyId));
  return instance.id;
}

strategyRoutes.get('/', async (c) => {
  const { offeringId } = offeringQuery.parse({ offeringId: c.req.query('offeringId') });
  const { db } = c.var;
  const docs = await boardDocs(db, offeringId);
  const runs = await db
    .select({
      id: examStrategies.id,
      version: examStrategies.version,
      status: examStrategies.status,
      statusMessage: examStrategies.statusMessage,
      progress: examStrategies.progress,
      costUsdNano: examStrategies.costUsdNano,
      createdAt: examStrategies.createdAt,
      updatedAt: examStrategies.updatedAt,
      approvedAt: examStrategies.approvedAt,
      promptVersion: examStrategies.promptVersion,
    })
    .from(examStrategies)
    .where(eq(examStrategies.offeringId, offeringId))
    .orderBy(desc(examStrategies.version));
  return c.json({
    processingEnabled: processingEnabled(c.env),
    documents: docs,
    estimate: await estimate(
      db,
      docs.map((d) => d.id),
    ),
    runs: runs.map((r) => ({
      ...r,
      progress: r.progress ? { ...r.progress, checkpoints: undefined } : null,
      stalled: r.status === 'compiling' && Date.now() - r.updatedAt.getTime() > STALL_MS,
    })),
  });
});

strategyRoutes.post('/compile', async (c) => {
  const { db, user: me } = c.var;
  if (!processingEnabled(c.env)) throw badRequest(PROCESS_ON_LOCAL);
  const { offeringId } = await parseBody(c, offeringQuery);
  const docs = await boardDocs(db, offeringId);
  if (!docs.some((d) => d.category === 'blueprint'))
    throw badRequest('Publish the blueprint (board material) for this subject first');
  const running = await db
    .select()
    .from(examStrategies)
    .where(and(eq(examStrategies.offeringId, offeringId), eq(examStrategies.status, 'compiling')));
  if (running.some((r) => !isStalled(r)))
    throw conflict('A strategy is already being compiled for this subject');
  const last = await db
    .select({ v: sql<number>`coalesce(max(${examStrategies.version}), 0)` })
    .from(examStrategies)
    .where(eq(examStrategies.offeringId, offeringId))
    .get();
  const row = await db
    .insert(examStrategies)
    .values({
      offeringId,
      version: Number(last?.v ?? 0) + 1,
      sourceBookIds: docs.map((d) => d.id),
      promptVersion: STRATEGY_PROMPT_VERSION,
      createdBy: me.id,
    })
    .returning({ id: examStrategies.id, version: examStrategies.version })
    .get();
  await audit(db, me.id, 'compile_strategy', 'exam_strategy', row.id, {
    offeringId,
    documents: docs.length,
  });
  const workflowId = await start(c.env, db, { strategyId: row.id, userId: me.id });
  return c.json({ ...row, workflowId }, 202);
});

/** Continue a run that stopped (no progress for 10 min) or failed: finished steps are skipped. */
strategyRoutes.post('/:id/continue', async (c) => {
  const { db, user: me } = c.var;
  if (!processingEnabled(c.env)) throw badRequest(PROCESS_ON_LOCAL);
  const run = await db
    .select()
    .from(examStrategies)
    .where(eq(examStrategies.id, c.req.param('id')))
    .get();
  if (!run) throw notFound('Strategy');
  if (!(run.status === 'failed' || isStalled(run)))
    throw conflict('Only a stopped or failed compile can be continued');
  await db
    .update(examStrategies)
    .set({ status: 'compiling', statusMessage: null, updatedAt: new Date() })
    .where(eq(examStrategies.id, run.id));
  const workflowId = await start(c.env, db, { strategyId: run.id, userId: me.id });
  return c.json({ ok: true, workflowId }, 202);
});

strategyRoutes.get('/:id', async (c) => {
  const { db } = c.var;
  const run = await db
    .select()
    .from(examStrategies)
    .where(eq(examStrategies.id, c.req.param('id')))
    .get();
  if (!run) throw notFound('Strategy');
  return c.json({
    ...run,
    progress: run.progress ? { ...run.progress, checkpoints: undefined } : null,
    stalled: isStalled(run),
  });
});

const itemsQuery = z.object({
  chapter: z.coerce.number().int().optional(),
  part: z.enum(['A', 'B', 'C', 'D']).optional(),
  source: z.enum(['board_exam', 'model_paper', 'practice_paper', 'bank']).optional(),
  topic: z.string().max(140).optional(),
});

strategyRoutes.get('/:id/items', async (c) => {
  const q = itemsQuery.parse(c.req.query());
  const conds = [eq(boardItems.strategyId, c.req.param('id'))];
  if (q.chapter) conds.push(eq(boardItems.chapter, q.chapter));
  if (q.part) conds.push(eq(boardItems.part, q.part));
  if (q.source) conds.push(eq(boardItems.source, q.source));
  if (q.topic) conds.push(eq(boardItems.topicGroup, q.topic));
  const rows = await c.var.db
    .select({
      id: boardItems.id,
      bookId: boardItems.bookId,
      bookTitle: books.title,
      page: boardItems.page,
      source: boardItems.source,
      paperLabel: boardItems.paperLabel,
      examYear: boardItems.examYear,
      qno: boardItems.qno,
      part: boardItems.part,
      marks: boardItems.marks,
      chapter: boardItems.chapter,
      topic: boardItems.topic,
      topicGroup: boardItems.topicGroup,
      typology: boardItems.typology,
      cognitive: boardItems.cognitive,
      difficulty: boardItems.difficulty,
      text: boardItems.text,
      answer: boardItems.answer,
      markSplit: boardItems.markSplit,
      markingPoints: boardItems.markingPoints,
    })
    .from(boardItems)
    .innerJoin(books, eq(books.id, boardItems.bookId))
    .where(and(...conds))
    .orderBy(boardItems.chapter, boardItems.source, boardItems.paperLabel, boardItems.page)
    .limit(300);
  return c.json(rows);
});

const approveSchema = z.object({ note: z.string().trim().max(1000).optional() });

/** Approve a draft: it becomes the strategy journeys read; the previous approved one is superseded. */
strategyRoutes.post('/:id/approve', async (c) => {
  const { db, user: me } = c.var;
  const { note } = await parseBody(c, approveSchema);
  const run = await db
    .select()
    .from(examStrategies)
    .where(eq(examStrategies.id, c.req.param('id')))
    .get();
  if (!run) throw notFound('Strategy');
  if (run.status !== 'draft') throw conflict('Only a draft strategy can be approved');
  await db.batch([
    db
      .update(examStrategies)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(
        and(eq(examStrategies.offeringId, run.offeringId), eq(examStrategies.status, 'approved')),
      ),
    db
      .update(examStrategies)
      .set({
        status: 'approved',
        approvedBy: me.id,
        approvedAt: new Date(),
        reviewNote: note ?? null,
        updatedAt: new Date(),
      })
      .where(eq(examStrategies.id, run.id)),
  ]);
  await audit(db, me.id, 'approve_strategy', 'exam_strategy', run.id, { version: run.version });
  return c.json({ ok: true });
});

async function draftRun(db: Db, id: string) {
  const run = await db.select().from(examStrategies).where(eq(examStrategies.id, id)).get();
  if (!run) throw notFound('Strategy');
  if (run.status !== 'draft') throw conflict('Only a draft can be corrected');
  return run;
}

/** Papers found in a run (per document and label), for the Admin to check before approving. */
strategyRoutes.get('/:id/papers', async (c) => {
  const rows = await c.var.db
    .select({
      bookId: boardItems.bookId,
      bookTitle: books.title,
      category: books.category,
      source: boardItems.source,
      paperLabel: boardItems.paperLabel,
      examYear: sql<number | null>`max(${boardItems.examYear})`,
      fromPage: sql<number>`min(${boardItems.page})`,
      toPage: sql<number>`max(${boardItems.page})`,
      questions: sql<number>`count(*)`,
      parts: sql<string>`group_concat(distinct ${boardItems.part})`,
    })
    .from(boardItems)
    .innerJoin(books, eq(books.id, boardItems.bookId))
    .where(eq(boardItems.strategyId, c.req.param('id')))
    .groupBy(boardItems.bookId, boardItems.source, boardItems.paperLabel)
    .orderBy(books.title, sql`min(${boardItems.page})`);
  return c.json(rows.map((r) => ({ ...r, questions: Number(r.questions) })));
});

const relabelSchema = z
  .object({
    bookId: z.string().min(1),
    fromPage: z.coerce.number().int().positive(),
    toPage: z.coerce.number().int().positive(),
    source: z.enum(['board_exam', 'model_paper', 'practice_paper', 'bank']),
    paperLabel: z.string().trim().max(80).optional(),
    examYear: z.coerce.number().int().min(2000).max(2100).optional(),
  })
  .refine((v) => v.toPage >= v.fromPage, 'The last page must not be before the first')
  .refine((v) => v.source === 'bank' || !!v.paperLabel, 'Give the paper a name (label)')
  .refine((v) => v.source !== 'board_exam' || !!v.examYear, 'Give the exam year of a board paper');

/**
 * Correct what a range of pages is (e.g. "pages 230-240 of the bank are practice paper X1-2025").
 * Free (no model call); then Reassemble.
 */
strategyRoutes.post('/:id/relabel', async (c) => {
  const { db, user: me } = c.var;
  const run = await draftRun(db, c.req.param('id'));
  const v = await parseBody(c, relabelSchema);
  const res = await db
    .update(boardItems)
    .set({
      source: v.source,
      paperLabel: v.source === 'bank' ? null : v.paperLabel,
      examYear: v.source === 'board_exam' ? v.examYear : null,
    })
    .where(
      and(
        eq(boardItems.strategyId, run.id),
        eq(boardItems.bookId, v.bookId),
        sql`${boardItems.page} >= ${v.fromPage}`,
        sql`${boardItems.page} <= ${v.toPage}`,
      ),
    )
    .returning({ id: boardItems.id });
  await audit(db, me.id, 'relabel_strategy_pages', 'exam_strategy', run.id, {
    ...v,
    questions: res.length,
  });
  return c.json({ questions: res.length });
});

/** Rebuild the draft from its tagged questions after corrections (no model calls, free). */
strategyRoutes.post('/:id/reassemble', async (c) => {
  const { db, user: me } = c.var;
  const run = await draftRun(db, c.req.param('id'));
  const questions = await assembleRun(db, run.id);
  await audit(db, me.id, 'reassemble_strategy', 'exam_strategy', run.id, { questions });
  return c.json({ ok: true, questions });
});
