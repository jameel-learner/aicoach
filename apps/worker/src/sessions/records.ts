import {
  KNOWN_BOX,
  nextReview,
  type ArtefactKind,
  type JourneyId,
  type RecallRating,
  type SessionStatus,
} from '@aicoach/core';
import {
  cardReviews,
  learnerArtefacts,
  mastery,
  sessionEvents,
  studySessions,
  type Db,
} from '@aicoach/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * What a session leaves behind in D1 (decision 9.6-3): the session index and step log, topic
 * mastery, card review state and the learner's own cards and memory hooks. Every write here is
 * safe to repeat, so a step that is retried after a failure doesn't double-count.
 */

export interface SessionRow {
  id: string;
  userId: string;
  offeringId: string;
  enrolmentId: string | null;
  journey: JourneyId;
  graphVersion: number;
  chapter: number;
  topic: string;
  title: string;
}

export async function createSessionRow(db: Db, s: SessionRow, node: string) {
  await db.insert(studySessions).values({ ...s, node, status: 'active', seq: 0 });
}

export async function recordStep(
  db: Db,
  sessionId: string,
  step: {
    seq: number;
    edge: string;
    from: string;
    to: string;
    billedMicro: number;
    totalBilledMicro: number;
    status: SessionStatus;
    outcome?: unknown;
  },
) {
  const ended = step.status !== 'active' && step.status !== 'paused';
  await db.batch([
    db
      .insert(sessionEvents)
      .values({
        sessionId,
        seq: step.seq,
        edge: step.edge,
        fromNode: step.from,
        toNode: step.to,
        billedMicro: step.billedMicro,
      })
      .onConflictDoNothing(),
    db
      .update(studySessions)
      .set({
        node: step.to,
        seq: step.seq,
        status: step.status,
        billedMicro: step.totalBilledMicro,
        ...(ended ? { outcome: step.outcome ?? null, finishedAt: new Date() } : {}),
      })
      .where(eq(studySessions.id, sessionId)),
  ]);
}

export async function setSessionStatus(db: Db, sessionId: string, status: SessionStatus) {
  await db.update(studySessions).set({ status }).where(eq(studySessions.id, sessionId));
}

/** Latest result per topic, plus the best ever and how many sessions (decision 9.6-9). */
export async function saveMastery(
  db: Db,
  s: Pick<SessionRow, 'id' | 'userId' | 'offeringId' | 'chapter' | 'topic'>,
  level: number,
) {
  await db
    .insert(mastery)
    .values({
      userId: s.userId,
      offeringId: s.offeringId,
      chapter: s.chapter,
      topic: s.topic,
      level,
      best: level,
      sessions: 1,
      lastSessionId: s.id,
    })
    .onConflictDoUpdate({
      target: [mastery.userId, mastery.offeringId, mastery.chapter, mastery.topic],
      set: {
        level,
        best: sql`max(${mastery.best}, ${level})`,
        sessions: sql`${mastery.sessions} + 1`,
        lastSessionId: s.id,
        updatedAt: new Date(),
      },
      // The same session reported twice (a retried step) changes nothing.
      setWhere: sql`${mastery.lastSessionId} is not ${s.id}`,
    });
}

/** One rating of one card: moves it between Leitner boxes and sets when it is due again. */
export async function saveReview(
  db: Db,
  o: {
    userId: string;
    offeringId: string;
    chapter: number;
    cardKey: string;
    /** Box before this session (0 = new). */
    box: number;
    rating: RecallRating;
    now: number;
    /** The card already came up in this session. */
    repeat: boolean;
  },
) {
  const next = nextReview(o.repeat ? 1 : o.box, o.rating, o.now, o.repeat);
  const lapse = o.rating === 'forgot' ? 1 : 0;
  await db
    .insert(cardReviews)
    .values({
      userId: o.userId,
      offeringId: o.offeringId,
      cardKey: o.cardKey,
      chapter: o.chapter,
      box: next.box,
      dueAt: new Date(next.dueAt),
      reviews: 1,
      lapses: lapse,
      lastRating: o.rating,
    })
    .onConflictDoUpdate({
      target: [cardReviews.userId, cardReviews.offeringId, cardReviews.cardKey],
      set: {
        box: next.box,
        dueAt: new Date(next.dueAt),
        reviews: sql`${cardReviews.reviews} + 1`,
        lapses: sql`${cardReviews.lapses} + ${lapse}`,
        lastRating: o.rating,
        updatedAt: new Date(),
      },
    });
  return next;
}

export async function saveArtefact(
  db: Db,
  a: {
    userId: string;
    offeringId: string;
    kind: ArtefactKind;
    chapter: number;
    topic: string;
    cardKey?: string | null;
    content: Record<string, string>;
    sessionId?: string | null;
  },
): Promise<string> {
  // One memory hook per card: a new one replaces the old (kept as "removed", never deleted).
  if (a.kind === 'mnemonic' && a.cardKey)
    await db
      .update(learnerArtefacts)
      .set({ status: 'removed' })
      .where(
        and(
          eq(learnerArtefacts.userId, a.userId),
          eq(learnerArtefacts.offeringId, a.offeringId),
          eq(learnerArtefacts.kind, 'mnemonic'),
          eq(learnerArtefacts.cardKey, a.cardKey),
          eq(learnerArtefacts.status, 'active'),
        ),
      );
  const row = await db
    .insert(learnerArtefacts)
    .values({
      userId: a.userId,
      offeringId: a.offeringId,
      kind: a.kind,
      chapter: a.chapter,
      topic: a.topic,
      cardKey: a.cardKey ?? null,
      content: a.content,
      sessionId: a.sessionId ?? null,
    })
    .returning({ id: learnerArtefacts.id })
    .get();
  return row.id;
}

// ---------------------------------------------------------------- reading progress back

export interface Progress {
  /** Calendar days (India) on which at least one step of a session was taken. */
  daysStudied: number;
  sessionsFinished: number;
  topics: { started: number; gotIt: number };
  cards: { reviewed: number; known: number; due: number };
  ownCards: number;
  hooks: number;
}

/** Honest, private numbers (spec 5.5.4, 5.5.9): counts of what the learner did, nothing derived. */
export async function progressFor(
  db: Db,
  userId: string,
  offeringId: string,
  now: number,
): Promise<Progress> {
  const mine = and(eq(studySessions.userId, userId), eq(studySessions.offeringId, offeringId));
  const [days, finished, topics, cards, artefacts] = await Promise.all([
    db
      .select({
        n: sql<number>`count(distinct date((${studySessions.updatedAt} + 19800000) / 1000, 'unixepoch'))`,
      })
      .from(studySessions)
      .where(and(mine, sql`${studySessions.seq} > 0`))
      .get(),
    db
      .select({ n: sql<number>`count(*)` })
      .from(studySessions)
      .where(and(mine, inArray(studySessions.status, ['done', 'stopped'])))
      .get(),
    db
      .select({
        started: sql<number>`count(*)`,
        gotIt: sql<number>`coalesce(sum(case when ${mastery.level} >= 2 then 1 else 0 end), 0)`,
      })
      .from(mastery)
      .where(and(eq(mastery.userId, userId), eq(mastery.offeringId, offeringId)))
      .get(),
    db
      .select({
        reviewed: sql<number>`count(*)`,
        known: sql<number>`coalesce(sum(case when ${cardReviews.box} >= ${KNOWN_BOX} then 1 else 0 end), 0)`,
        due: sql<number>`coalesce(sum(case when ${cardReviews.dueAt} <= ${now} then 1 else 0 end), 0)`,
      })
      .from(cardReviews)
      .where(and(eq(cardReviews.userId, userId), eq(cardReviews.offeringId, offeringId)))
      .get(),
    db
      .select({ kind: learnerArtefacts.kind, n: sql<number>`count(*)` })
      .from(learnerArtefacts)
      .where(
        and(
          eq(learnerArtefacts.userId, userId),
          eq(learnerArtefacts.offeringId, offeringId),
          eq(learnerArtefacts.status, 'active'),
        ),
      )
      .groupBy(learnerArtefacts.kind),
  ]);
  const n = (v: unknown) => Number(v ?? 0);
  return {
    daysStudied: n(days?.n),
    sessionsFinished: n(finished?.n),
    topics: { started: n(topics?.started), gotIt: n(topics?.gotIt) },
    cards: { reviewed: n(cards?.reviewed), known: n(cards?.known), due: n(cards?.due) },
    ownCards: n(artefacts.find((a) => a.kind === 'card')?.n),
    hooks: n(artefacts.find((a) => a.kind === 'mnemonic')?.n),
  };
}
