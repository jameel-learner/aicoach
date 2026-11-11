import {
  subjectMap,
  type ConceptGraphDraft,
  type ConceptNode,
  type ExamStrategy,
} from '@aicoach/core';
import { enrolments, learningAssets, type Db } from '@aicoach/db';
import { and, eq, max } from 'drizzle-orm';
import { Hono } from 'hono';
import { approvedStrategy } from '../assets/generate';
import type { AppBindings, SessionUser } from '../env';
import { badRequest, notFound } from '../lib/http';
import { requireAuth } from '../middleware/session';

/**
 * Learning material for learners (architecture §7 Phase 3: browse notes/cards per chapter, marks
 * badges, offline caching on the phone). Only APPROVED assets, only for a subject the user is
 * enrolled in (student or teacher); Admin may pass any offeringId. The material is platform
 * content, the same for every institution. `stamp` changes whenever something is (re)approved,
 * so the app knows when its offline copy is out of date.
 */
export const learnerMaterialRoutes = new Hono<AppBindings>();
learnerMaterialRoutes.use('*', requireAuth);

async function offeringFor(
  db: Db,
  me: SessionUser,
  q: { enrolmentId?: string; offeringId?: string },
): Promise<string> {
  if (me.role === 'admin' && q.offeringId) return q.offeringId;
  const mine = await db
    .select({ id: enrolments.id, offeringId: enrolments.offeringId })
    .from(enrolments)
    .where(and(eq(enrolments.userId, me.id), eq(enrolments.status, 'active')));
  const e = (q.enrolmentId && mine.find((x) => x.id === q.enrolmentId)) || mine[0];
  if (!e) throw badRequest('Join a class or choose a subject first');
  return e.offeringId;
}

const approved = (db: Db, offeringId: string, chapter?: number) =>
  db
    .select({
      id: learningAssets.id,
      kind: learningAssets.kind,
      chapter: learningAssets.chapter,
      topic: learningAssets.topic,
      marks: learningAssets.marks,
      version: learningAssets.version,
      content: learningAssets.content,
      sources: learningAssets.sources,
    })
    .from(learningAssets)
    .where(
      and(
        eq(learningAssets.offeringId, offeringId),
        eq(learningAssets.status, 'approved'),
        ...(chapter === undefined ? [] : [eq(learningAssets.chapter, chapter)]),
      ),
    )
    .orderBy(learningAssets.topic, learningAssets.marks);

async function stampOf(db: Db, offeringId: string) {
  const r = await db
    .select({ at: max(learningAssets.reviewedAt) })
    .from(learningAssets)
    .where(and(eq(learningAssets.offeringId, offeringId), eq(learningAssets.status, 'approved')))
    .get();
  return r?.at ? new Date(r.at).getTime() : 0;
}

const query = (c: { req: { query: (k: string) => string | undefined } }) => ({
  enrolmentId: c.req.query('enrolmentId') || undefined,
  offeringId: c.req.query('offeringId') || undefined,
});

/** Chapters with how much approved material each has (the subject-wise map comes along). */
learnerMaterialRoutes.get('/', async (c) => {
  const { db, user: me } = c.var;
  const offeringId = await offeringFor(db, me, query(c));
  const strat = await approvedStrategy(db, offeringId);
  if (!strat?.strategy) return c.json({ offeringId, ready: false, chapters: [], stamp: 0 });
  const map = subjectMap(strat.strategy as ExamStrategy);
  const assets = await approved(db, offeringId);
  return c.json({
    offeringId,
    ready: assets.length > 0,
    subject: map.subject,
    stamp: await stampOf(db, offeringId),
    chapters: map.chapters.map((ch) => {
      const mine = assets.filter((a) => a.chapter === ch.no);
      return {
        ...ch,
        notes: mine.filter((a) => a.kind === 'note').length,
        cards: mine.some((a) => a.kind === 'cards'),
        questionSets: mine
          .filter((a) => a.kind === 'questions')
          .map((a) => a.marks)
          .sort((a, b) => a - b),
      };
    }),
  });
});

/** One chapter's approved notes, memory map + cards, question sets and topic prerequisites. */
learnerMaterialRoutes.get('/chapters/:no', async (c) => {
  const { db, user: me } = c.var;
  const no = Number(c.req.param('no'));
  if (!Number.isInteger(no) || no < 1) throw badRequest('Chapter number expected');
  const offeringId = await offeringFor(db, me, query(c));
  const strat = await approvedStrategy(db, offeringId);
  const s = strat?.strategy as ExamStrategy | undefined;
  const ch = s?.chapters.find((x) => x.no === no);
  if (!s || !ch) throw notFound('Chapter');
  const assets = await approved(db, offeringId, no);
  const graph = (await approved(db, offeringId, 0)).find((a) => a.kind === 'graph');
  const prerequisites: Record<string, { topic: string; chapter: number; why: string }[]> = {};
  if (graph) {
    const g = graph.content as { nodes: ConceptNode[] } & ConceptGraphDraft;
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    for (const e of g.edges) {
      const to = byId.get(e.to);
      const from = byId.get(e.from);
      if (!to || !from || to.chapter !== no) continue;
      (prerequisites[to.topic] ??= []).push({
        topic: from.topic,
        chapter: from.chapter,
        why: e.why,
      });
    }
  }
  const pick = (a: (typeof assets)[number]) => ({
    id: a.id,
    topic: a.topic,
    marks: a.marks,
    version: a.version,
    content: a.content,
    sources: a.sources,
  });
  return c.json({
    offeringId,
    stamp: await stampOf(db, offeringId),
    chapter: {
      no: ch.no,
      title: ch.title,
      marks: ch.marks,
      topics: ch.topics.map((t) => ({ name: t.name, examPapers: t.examPapers, marks: t.marks })),
    },
    notes: assets.filter((a) => a.kind === 'note').map(pick),
    cards: assets.filter((a) => a.kind === 'cards').map(pick)[0] ?? null,
    questions: assets.filter((a) => a.kind === 'questions').map(pick),
    prerequisites,
  });
});
