import {
  sessionActSchema,
  startOf,
  startSessionSchema,
  type ExamStrategy,
  type JourneyId,
} from '@aicoach/core';
import {
  cardReviews,
  learnerArtefacts,
  learningAssets,
  mastery,
  studySessions,
  type Db,
} from '@aicoach/db';
import { explainStart, memoriseStart } from '@aicoach/journeys';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { approvedStrategy } from '../assets/generate';
import type { AppBindings, Env } from '../env';
import { AppError, badRequest, notFound, parseBody } from '../lib/http';
import { requireAuth } from '../middleware/session';
import { JOURNEY_RUNTIME } from '../sessions/agent';
import { buildExplainPlan, buildMemorisePlan, studyContext } from '../sessions/plan';
import { createSessionRow, progressFor, setSessionStatus } from '../sessions/records';

/**
 * Study sessions (architecture §3.7, §7 Phase 4).
 *   GET  /api/sessions/home      one-tap resume, what to do next, honest progress
 *   POST /api/sessions           start (or resume the open session for the same topic / chapter)
 *   GET  /api/sessions/:id       the current step (resume on any device)
 *   POST /api/sessions/:id/act   one learner action → SSE (delta*, view | error) or JSON
 * A session belongs to one learner; nobody else can read it (private progress, spec 5.5.9).
 */
export const sessionRoutes = new Hono<AppBindings>();
sessionRoutes.use('*', requireAuth);

const agent = (env: Env, id: string) => {
  if (!env.SESSION_AGENT) throw new AppError(503, 'unavailable', 'Study sessions are not set up');
  return env.SESSION_AGENT.get(env.SESSION_AGENT.idFromName(id));
};

const OPEN = ['active', 'paused'] as const;

async function ownSession(db: Db, userId: string, id: string) {
  const row = await db.select().from(studySessions).where(eq(studySessions.id, id)).get();
  // Someone else's session looks exactly like one that doesn't exist.
  if (!row || row.userId !== userId) throw notFound('Session');
  return row;
}

interface Suggestion {
  journey: JourneyId;
  chapter: number;
  chapterTitle: string;
  topic?: string;
  title: string;
  reason: string;
}

/** What to do next: cards that are due first, then the topics that carry the most marks. */
async function suggestions(
  db: Db,
  userId: string,
  offeringId: string,
  s: ExamStrategy,
  now: number,
): Promise<Suggestion[]> {
  const [assets, levels, reviewed, own] = await Promise.all([
    db
      .select({
        kind: learningAssets.kind,
        chapter: learningAssets.chapter,
        topic: learningAssets.topic,
        cards: sql<number>`case when ${learningAssets.kind} = 'cards' then json_array_length(${learningAssets.content}, '$.cards') else 0 end`,
      })
      .from(learningAssets)
      .where(
        and(
          eq(learningAssets.offeringId, offeringId),
          eq(learningAssets.status, 'approved'),
          inArray(learningAssets.kind, ['note', 'cards']),
        ),
      ),
    db
      .select({ chapter: mastery.chapter, topic: mastery.topic, level: mastery.level })
      .from(mastery)
      .where(and(eq(mastery.userId, userId), eq(mastery.offeringId, offeringId))),
    db
      .select({
        chapter: cardReviews.chapter,
        reviewed: sql<number>`count(*)`,
        due: sql<number>`sum(case when ${cardReviews.dueAt} <= ${now} then 1 else 0 end)`,
      })
      .from(cardReviews)
      .where(and(eq(cardReviews.userId, userId), eq(cardReviews.offeringId, offeringId)))
      .groupBy(cardReviews.chapter),
    db
      .select({ chapter: learnerArtefacts.chapter, n: sql<number>`count(*)` })
      .from(learnerArtefacts)
      .where(
        and(
          eq(learnerArtefacts.userId, userId),
          eq(learnerArtefacts.offeringId, offeringId),
          eq(learnerArtefacts.kind, 'card'),
          eq(learnerArtefacts.status, 'active'),
        ),
      )
      .groupBy(learnerArtefacts.chapter),
  ]);
  const chapterOf = (no: number) => s.chapters.find((c) => c.no === no);
  const out: Suggestion[] = [];

  // Memorise: the chapter with the most cards due; if none are due, the heaviest chapter with new cards.
  const decks = assets
    .filter((a) => a.kind === 'cards')
    .map((a) => {
      const r = reviewed.find((x) => x.chapter === a.chapter);
      const total = Number(a.cards) + Number(own.find((o) => o.chapter === a.chapter)?.n ?? 0);
      const due = Number(r?.due ?? 0);
      return { chapter: a.chapter, due, fresh: Math.max(0, total - Number(r?.reviewed ?? 0)) };
    })
    .filter((d) => chapterOf(d.chapter));
  const deck =
    [...decks].sort((a, b) => b.due - a.due).find((d) => d.due > 0) ??
    [...decks]
      .sort((a, b) => chapterOf(b.chapter)!.marks - chapterOf(a.chapter)!.marks)
      .find((d) => d.fresh > 0);
  if (deck) {
    const ch = chapterOf(deck.chapter)!;
    out.push({
      journey: 'memorise',
      chapter: ch.no,
      chapterTitle: ch.title,
      title: `Cards: ${ch.title}`,
      reason: deck.due
        ? `${deck.due} card${deck.due === 1 ? '' : 's'} due for review`
        : `${deck.fresh} new card${deck.fresh === 1 ? '' : 's'}`,
    });
  }

  // Explain: topics with notes that aren't "got it" yet; most marks first, then most asked.
  const topics = new Map<string, { chapter: number; topic: string }>();
  for (const a of assets)
    if (a.kind === 'note')
      topics.set(`${a.chapter}|${a.topic}`, { chapter: a.chapter, topic: a.topic });
  const papers = s.exams?.papers ?? 0;
  const ranked = [...topics.values()]
    .map((t) => {
      const ch = chapterOf(t.chapter);
      const stat = ch?.topics.find((x) => x.name.toLowerCase() === t.topic.toLowerCase());
      const level = levels.find((l) => l.chapter === t.chapter && l.topic === t.topic)?.level ?? 0;
      return { ...t, ch, level, asked: stat?.examPapers ?? 0 };
    })
    .filter((t) => t.ch && t.level < 2)
    .sort(
      (a, b) => b.ch!.marks - a.ch!.marks || b.asked - a.asked || a.topic.localeCompare(b.topic),
    );
  for (const t of ranked.slice(0, 3))
    out.push({
      journey: 'explain',
      chapter: t.chapter,
      chapterTitle: t.ch!.title,
      topic: t.topic,
      title: t.topic,
      reason:
        t.level === 1
          ? 'You have seen this. Try the check question again'
          : papers && t.asked
            ? `Asked in ${t.asked} of ${papers} board papers · chapter worth ${t.ch!.marks} marks`
            : `Chapter worth ${t.ch!.marks} marks`,
    });
  return out;
}

sessionRoutes.get('/home', async (c) => {
  const { db, user: me } = c.var;
  const ctx = await studyContext(db, me, {
    enrolmentId: c.req.query('enrolmentId') || undefined,
    offeringId: c.req.query('offeringId') || undefined,
  });
  const now = Date.now();
  const [strat, open, progress] = await Promise.all([
    approvedStrategy(db, ctx.offeringId),
    db
      .select({
        id: studySessions.id,
        journey: studySessions.journey,
        title: studySessions.title,
        chapter: studySessions.chapter,
        status: studySessions.status,
        updatedAt: studySessions.updatedAt,
      })
      .from(studySessions)
      .where(
        and(
          eq(studySessions.userId, me.id),
          eq(studySessions.offeringId, ctx.offeringId),
          inArray(studySessions.status, [...OPEN]),
        ),
      )
      .orderBy(desc(studySessions.updatedAt))
      .limit(1)
      .get(),
    progressFor(db, me.id, ctx.offeringId, now),
  ]);
  const s = strat?.strategy as ExamStrategy | undefined;
  return c.json({
    offeringId: ctx.offeringId,
    ready: !!s,
    resume: open ? { ...open, updatedAt: open.updatedAt.getTime() } : null,
    suggestions: s ? await suggestions(db, me.id, ctx.offeringId, s, now) : [],
    progress,
  });
});

sessionRoutes.post('/', async (c) => {
  const body = await parseBody(c, startSessionSchema);
  const { db, user: me } = c.var;
  const ctx = await studyContext(db, me, body);
  if (body.journey === 'explain' && !body.topic) throw badRequest('Choose a topic');
  const topic = body.journey === 'explain' ? body.topic! : '';

  // One open session per topic (or per chapter's cards): starting it again resumes it.
  const open = await db
    .select({ id: studySessions.id, topic: studySessions.topic })
    .from(studySessions)
    .where(
      and(
        eq(studySessions.userId, me.id),
        eq(studySessions.offeringId, ctx.offeringId),
        eq(studySessions.journey, body.journey),
        eq(studySessions.chapter, body.chapter),
        inArray(studySessions.status, [...OPEN]),
      ),
    )
    .orderBy(desc(studySessions.updatedAt));
  for (const o of open.filter((x) => x.topic.toLowerCase() === topic.toLowerCase())) {
    const view = await agent(c.env, o.id).current(me.id);
    if (view) return c.json({ view, resumed: true });
    await setSessionStatus(db, o.id, 'expired'); // its state is gone: start afresh
  }

  const now = Date.now();
  const j = JOURNEY_RUNTIME[body.journey];
  const id = crypto.randomUUID();
  let state: unknown;
  let title: string;
  let stored = topic;
  if (body.journey === 'explain') {
    const plan = await buildExplainPlan(db, me, ctx.offeringId, body.chapter, topic);
    state = explainStart(plan);
    title = plan.topic;
    stored = plan.topic;
  } else {
    const plan = await buildMemorisePlan(db, me, ctx.offeringId, body.chapter, now);
    state = memoriseStart(plan);
    title = `Cards: ${plan.chapter.title}`;
  }
  const row = {
    id,
    userId: me.id,
    offeringId: ctx.offeringId,
    enrolmentId: ctx.enrolmentId,
    journey: body.journey,
    graphVersion: j.graph.version,
    chapter: body.chapter,
    topic: stored,
    title,
  };
  const cp = startOf(j.graph, state);
  await createSessionRow(db, row, cp.node);
  const view = await agent(c.env, id).begin({ ...row, cp });
  return c.json({ view, resumed: false }, 201);
});

sessionRoutes.get('/:id', async (c) => {
  const { db, user: me } = c.var;
  const row = await ownSession(db, me.id, c.req.param('id'));
  const view = await agent(c.env, row.id).current(me.id);
  if (!view) throw new AppError(410, 'gone', 'This session has ended');
  return c.json({ view });
});

sessionRoutes.post('/:id/act', async (c) => {
  const input = await parseBody(c, sessionActSchema);
  const { db, user: me } = c.var;
  const row = await ownSession(db, me.id, c.req.param('id'));
  const res = await agent(c.env, row.id).fetch('https://session/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ me, input }),
  });
  if (!input.stream || !res.body) return res;
  // Keep reading the agent's stream to its end even if the app disconnects, so the step finishes
  // and the model call is settled (as in Ask).
  const [toClient, toEnd] = res.body.tee();
  c.executionCtx.waitUntil(
    (async () => {
      const reader = toEnd.getReader();
      while (!(await reader.read()).done);
    })().catch(() => {}),
  );
  return new Response(toClient, { headers: res.headers });
});
