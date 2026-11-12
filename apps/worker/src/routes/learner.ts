import {
  editArtefactSchema,
  INTEREST_OPTIONS,
  interestsSchema,
  ownCardSchema,
} from '@aicoach/core';
import { learnerArtefacts, learnerInterests, mastery, safetyEvents, user } from '@aicoach/db';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppBindings, Env, SessionUser } from '../env';
import { notFound, parseBody } from '../lib/http';
import type { Notifier } from '../lib/notifier';
import { requireAuth, requireRole } from '../middleware/session';
import { classify } from '../safety/classify';
import { handoff, handoffMessage } from '../safety/handoff';
import type { Db } from '@aicoach/db';
import { interestsOf, studyContext } from '../sessions/plan';
import { progressFor, saveArtefact } from '../sessions/records';

/**
 * The learner's own things (architecture §6.1, §7 Phase 4):
 *   /api/learner/interests   declared interests (chosen, never inferred)
 *   /api/learner/artefacts   their locker: own cards and memory hooks
 *   /api/learner/progress    honest, private progress
 * Everything here is the signed-in user's own data; there is no way to ask for someone else's.
 */
export const learnerRoutes = new Hono<AppBindings>();
learnerRoutes.use('*', requireAuth);

const scopeQuery = (c: { req: { query: (k: string) => string | undefined } }) => ({
  enrolmentId: c.req.query('enrolmentId') || undefined,
  offeringId: c.req.query('offeringId') || undefined,
});

/** Text a learner writes into a card is checked like any other turn (decision 9.6-5). */
async function distressIn(env: Env, db: Db, notifier: Notifier, me: SessionUser, text: string) {
  const safety = await classify(env, text);
  if (safety.level !== 'distress') return null;
  const h = await handoff(db, notifier, me, {
    source: 'artefact',
    rule: safety.rule,
    detector: safety.detector,
  });
  return handoffMessage(h.told);
}

learnerRoutes.get('/interests', async (c) =>
  c.json({
    interests: await interestsOf(c.var.db, c.var.user.id),
    options: INTEREST_OPTIONS,
  }),
);

learnerRoutes.put('/interests', async (c) => {
  const body = await parseBody(c, interestsSchema);
  const interests = [...new Set(body.interests)];
  await c.var.db
    .insert(learnerInterests)
    .values({ userId: c.var.user.id, interests })
    .onConflictDoUpdate({
      target: learnerInterests.userId,
      set: { interests, updatedAt: new Date() },
    });
  return c.json({ interests });
});

learnerRoutes.get('/artefacts', async (c) => {
  const { db, user: me } = c.var;
  const ctx = await studyContext(db, me, scopeQuery(c));
  const rows = await db
    .select({
      id: learnerArtefacts.id,
      kind: learnerArtefacts.kind,
      chapter: learnerArtefacts.chapter,
      topic: learnerArtefacts.topic,
      content: learnerArtefacts.content,
      createdAt: learnerArtefacts.createdAt,
    })
    .from(learnerArtefacts)
    .where(
      and(
        eq(learnerArtefacts.userId, me.id),
        eq(learnerArtefacts.offeringId, ctx.offeringId),
        eq(learnerArtefacts.status, 'active'),
      ),
    )
    .orderBy(desc(learnerArtefacts.createdAt))
    .limit(300);
  return c.json({
    artefacts: rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime() })),
  });
});

/** A card the learner writes outside a session (it joins the chapter's memorise sessions). */
learnerRoutes.post('/artefacts', async (c) => {
  const body = await parseBody(c, ownCardSchema);
  const { db, user: me } = c.var;
  const ctx = await studyContext(db, me, body);
  const stop = await distressIn(c.env, db, c.var.notifier, me, `${body.front}\n${body.back}`);
  if (stop) return c.json({ handoff: stop });
  const id = await saveArtefact(db, {
    userId: me.id,
    offeringId: ctx.offeringId,
    kind: 'card',
    chapter: body.chapter,
    topic: body.topic ?? '',
    content: { front: body.front, back: body.back },
  });
  return c.json({ id }, 201);
});

async function ownArtefact(db: Db, userId: string, id: string) {
  const row = await db.select().from(learnerArtefacts).where(eq(learnerArtefacts.id, id)).get();
  if (!row || row.userId !== userId || row.status !== 'active') throw notFound('Card');
  return row;
}

learnerRoutes.patch('/artefacts/:id', async (c) => {
  const body = await parseBody(c, editArtefactSchema);
  const { db, user: me } = c.var;
  const row = await ownArtefact(db, me.id, c.req.param('id'));
  const content =
    row.kind === 'card'
      ? {
          ...row.content,
          ...(body.front ? { front: body.front } : {}),
          ...(body.back ? { back: body.back } : {}),
        }
      : { ...row.content, ...(body.text ? { text: body.text } : {}) };
  const stop = await distressIn(c.env, db, c.var.notifier, me, Object.values(content).join('\n'));
  if (stop) return c.json({ handoff: stop });
  await db.update(learnerArtefacts).set({ content }).where(eq(learnerArtefacts.id, row.id));
  return c.json({ id: row.id, content });
});

/** Removed from the locker and from future sessions; the row is kept (status "removed"). */
learnerRoutes.delete('/artefacts/:id', async (c) => {
  const { db, user: me } = c.var;
  const row = await ownArtefact(db, me.id, c.req.param('id'));
  await db
    .update(learnerArtefacts)
    .set({ status: 'removed' })
    .where(eq(learnerArtefacts.id, row.id));
  return c.json({ ok: true });
});

learnerRoutes.get('/progress', async (c) => {
  const { db, user: me } = c.var;
  const ctx = await studyContext(db, me, scopeQuery(c));
  const [summary, topics] = await Promise.all([
    progressFor(db, me.id, ctx.offeringId, Date.now()),
    db
      .select({
        chapter: mastery.chapter,
        topic: mastery.topic,
        level: mastery.level,
        sessions: mastery.sessions,
      })
      .from(mastery)
      .where(and(eq(mastery.userId, me.id), eq(mastery.offeringId, ctx.offeringId))),
  ]);
  return c.json({ offeringId: ctx.offeringId, summary, topics });
});

/**
 * Admin: safety triggers (who, when, which rule, who was told). The learner's words are not stored,
 * so there is nothing more to show (decision 9.6-5).
 */
export const safetyAdminRoutes = new Hono<AppBindings>();
safetyAdminRoutes.use('*', requireAuth, requireRole('admin'));
safetyAdminRoutes.get('/', async (c) => {
  const rows = await c.var.db
    .select({
      id: safetyEvents.id,
      createdAt: safetyEvents.createdAt,
      source: safetyEvents.source,
      detector: safetyEvents.detector,
      rule: safetyEvents.rule,
      notified: safetyEvents.notified,
      userId: safetyEvents.userId,
      name: user.name,
      email: user.email,
    })
    .from(safetyEvents)
    .innerJoin(user, eq(user.id, safetyEvents.userId))
    .orderBy(desc(safetyEvents.createdAt))
    .limit(200);
  return c.json({ events: rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime() })) });
});
