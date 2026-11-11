import { ASSET_KINDS, marksTarget } from '@aicoach/core';
import {
  assetReviews,
  boards,
  classGroups,
  enrolments,
  learningAssets,
  levels,
  subjectOfferings,
  subjects,
  type Db,
} from '@aicoach/db';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { approvedStrategy, latestAssets } from '../assets/generate';
import { reviewsOf, saveReview, teacherScoresByAsset } from '../assets/reviews';
import type { AppBindings, SessionUser } from '../env';
import { audit } from '../lib/audit';
import { forbidden, notFound, parseBody } from '../lib/http';
import { requireAuth, requireRole } from '../middleware/session';

/**
 * Teacher review of generated learning material (architecture §7 Phase 3): teachers of a subject
 * see its generated notes, cards, question sets and concept graph (drafts and approved) and give a
 * rubric score 1–5 with a comment. Reviews inform the Admin; only the Admin approves.
 */
export const reviewRoutes = new Hono<AppBindings>();
reviewRoutes.use('*', requireAuth, requireRole('teacher', 'admin'));

/** Offerings a teacher teaches (a teacher enrolment or a class they are class teacher of). */
async function taughtOfferings(db: Db, me: SessionUser) {
  if (me.role === 'admin') {
    const all = await db.select({ id: subjectOfferings.id }).from(subjectOfferings);
    return all.map((r) => r.id);
  }
  const [viaEnrolment, viaClass] = await Promise.all([
    db
      .select({ id: enrolments.offeringId })
      .from(enrolments)
      .where(
        and(
          eq(enrolments.userId, me.id),
          eq(enrolments.roleIn, 'teacher'),
          eq(enrolments.status, 'active'),
        ),
      ),
    db
      .select({ id: classGroups.offeringId })
      .from(classGroups)
      .where(eq(classGroups.classTeacherId, me.id)),
  ]);
  return [...new Set([...viaEnrolment, ...viaClass].map((r) => r.id))];
}

async function assertTeaches(db: Db, me: SessionUser, offeringId: string) {
  if (!(await taughtOfferings(db, me)).includes(offeringId))
    throw forbidden('You can review material only for subjects you teach');
}

reviewRoutes.get('/offerings', async (c) => {
  const ids = await taughtOfferings(c.var.db, c.var.user);
  if (!ids.length) return c.json([]);
  const rows = await c.var.db
    .select({
      id: subjectOfferings.id,
      board: boards.code,
      level: levels.name,
      subject: subjects.name,
    })
    .from(subjectOfferings)
    .innerJoin(boards, eq(boards.id, subjectOfferings.boardId))
    .innerJoin(levels, eq(levels.id, subjectOfferings.levelId))
    .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
    .where(inArray(subjectOfferings.id, ids.slice(0, 90)));
  const out = [];
  for (const r of rows) {
    const s = await approvedStrategy(c.var.db, r.id);
    if (s)
      out.push({
        ...r,
        chapters: (s.strategy as { chapters: { no: number; title: string }[] }).chapters.map(
          (ch) => ({ no: ch.no, title: ch.title }),
        ),
      });
  }
  return c.json(out);
});

const listQuery = z.object({
  offeringId: z.string().min(1),
  kind: z.enum(ASSET_KINDS).default('note'),
  chapter: z.coerce.number().int().nonnegative().optional(),
});

reviewRoutes.get('/assets', async (c) => {
  const q = listQuery.parse({
    offeringId: c.req.query('offeringId'),
    kind: c.req.query('kind') || undefined,
    chapter: c.req.query('chapter') || undefined,
  });
  const { db, user: me } = c.var;
  await assertTeaches(db, me, q.offeringId);
  const rows = (await latestAssets(db, q.offeringId, q.chapter, q.kind)).filter(
    (r) => r.status === 'draft' || r.status === 'approved',
  );
  const scores = await teacherScoresByAsset(
    db,
    rows.map((r) => r.id),
  );
  // My own score per asset, so the list shows what I have reviewed.
  const mine = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 90) {
    const ids = rows.slice(i, i + 90).map((r) => r.id);
    const got = await db
      .select({ assetId: assetReviews.assetId, score: assetReviews.score })
      .from(assetReviews)
      .where(and(eq(assetReviews.reviewerId, me.id), inArray(assetReviews.assetId, ids)));
    for (const g of got) mine.set(g.assetId, g.score);
  }
  return c.json(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      chapter: r.chapter,
      topic: r.topic,
      marks: r.marks,
      version: r.version,
      status: r.status,
      checks: r.checks,
      critique: r.critique,
      teacherReviews: scores.get(r.id) ?? null,
      myScore: mine.get(r.id) ?? null,
    })),
  );
});

reviewRoutes.get('/assets/:id', async (c) => {
  const { db, user: me } = c.var;
  const row = await db
    .select()
    .from(learningAssets)
    .where(eq(learningAssets.id, c.req.param('id')))
    .get();
  if (!row) throw notFound('Learning asset');
  await assertTeaches(db, me, row.offeringId);
  const reviews = await reviewsOf(db, row.id);
  return c.json({
    id: row.id,
    kind: row.kind,
    chapter: row.chapter,
    topic: row.topic,
    marks: row.marks,
    version: row.version,
    status: row.status,
    content: row.content,
    sources: row.sources,
    checks: row.checks,
    critique: row.critique,
    target: marksTarget(row.marks),
    myReview: reviews.find((r) => r.reviewerId === me.id) ?? null,
    teacherReviews: reviews.filter((r) => r.role === 'teacher').length,
  });
});

const reviewSchema = z.object({
  score: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});

/** Score (1–5) and comment; reviewing again replaces my earlier review of this version. */
reviewRoutes.put('/assets/:id', async (c) => {
  const { db, user: me } = c.var;
  const v = await parseBody(c, reviewSchema);
  const row = await db
    .select({
      id: learningAssets.id,
      offeringId: learningAssets.offeringId,
      status: learningAssets.status,
    })
    .from(learningAssets)
    .where(eq(learningAssets.id, c.req.param('id')))
    .get();
  if (!row) throw notFound('Learning asset');
  await assertTeaches(db, me, row.offeringId);
  await saveReview(db, {
    assetId: row.id,
    reviewerId: me.id,
    role: me.role === 'admin' ? 'admin' : 'teacher',
    score: v.score,
    comment: v.comment || null,
  });
  await audit(db, me.id, 'review_learning_asset', 'learning_asset', row.id, { score: v.score });
  return c.json({ ok: true });
});
