import {
  cardKey,
  examBudget,
  marksTarget,
  ownCardKey,
  stripCitations,
  type AssetSource,
  type CardsDraft,
  type ConceptNode,
  type ExamStrategy,
  type GeneratedQuestion,
  type QuestionSet,
  type StoredGraph,
  type StoredNote,
} from '@aicoach/core';
import {
  cardReviews,
  enrolments,
  learnerArtefacts,
  learnerInterests,
  learningAssets,
  studySessions,
  type Db,
} from '@aicoach/db';
import {
  MEMORISE_LIMITS,
  type ExplainPlan,
  type MemorisePlan,
  type RecallCard,
} from '@aicoach/journeys';
import { and, count, eq } from 'drizzle-orm';
import { approvedStrategy } from '../assets/generate';
import type { SessionUser } from '../env';
import { badRequest, forbidden, notFound } from '../lib/http';

/**
 * What a session studies, copied from the APPROVED material when it starts (decision 9.6-4), so a
 * later re-approval never changes a running session.
 */

export interface StudyContext {
  offeringId: string;
  enrolmentId: string | null;
}

/** Students study through an enrolment; Admin may name any subject (testing). Decision 9.6-10. */
export async function studyContext(
  db: Db,
  me: SessionUser,
  q: { enrolmentId?: string; offeringId?: string },
): Promise<StudyContext> {
  if (me.role === 'admin') {
    if (!q.offeringId) throw badRequest('offeringId is required');
    return { offeringId: q.offeringId, enrolmentId: null };
  }
  if (me.role !== 'student') throw forbidden('Study sessions are for students');
  const mine = await db
    .select({ id: enrolments.id, offeringId: enrolments.offeringId })
    .from(enrolments)
    .where(
      and(
        eq(enrolments.userId, me.id),
        eq(enrolments.roleIn, 'student'),
        eq(enrolments.status, 'active'),
      ),
    );
  // As in Ask: an id that isn't the student's own active enrolment falls back to their first.
  const e = (q.enrolmentId && mine.find((x) => x.id === q.enrolmentId)) || mine[0];
  if (!e) throw badRequest('Join a class or choose a subject first');
  return { offeringId: e.offeringId, enrolmentId: e.id };
}

export async function interestsOf(db: Db, userId: string): Promise<string[]> {
  const r = await db
    .select({ interests: learnerInterests.interests })
    .from(learnerInterests)
    .where(eq(learnerInterests.userId, userId))
    .get();
  return r?.interests ?? [];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface ApprovedAsset<T = unknown> {
  id: string;
  slotKey: string;
  kind: string;
  chapter: number;
  topic: string;
  marks: number;
  content: T;
  sources: AssetSource[];
}

export async function approvedAssets(db: Db, offeringId: string, chapter?: number) {
  const rows = await db
    .select({
      id: learningAssets.id,
      slotKey: learningAssets.slotKey,
      kind: learningAssets.kind,
      chapter: learningAssets.chapter,
      topic: learningAssets.topic,
      marks: learningAssets.marks,
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
    .orderBy(learningAssets.chapter, learningAssets.topic, learningAssets.marks);
  return rows as ApprovedAsset[];
}

export async function strategyOf(db: Db, offeringId: string): Promise<ExamStrategy> {
  const row = await approvedStrategy(db, offeringId);
  if (!row?.strategy) throw badRequest('Study material for this subject is not ready yet');
  return row.strategy as ExamStrategy;
}

/** Which MCQ option the model answer names: "(b) …" or the option's own text. null = can't tell. */
export function mcqCorrectIndex(options: string[] | null, answer: string): number | null {
  if (!options || options.length < 2) return null;
  const a = answer.toLowerCase();
  const letter = /(?:^|[^a-z])\(?([a-f])[).]/.exec(a)?.[1];
  if (letter) {
    const i = letter.charCodeAt(0) - 97;
    if (i < options.length) return i;
  }
  const hits = options
    .map((o, i) => ({
      i,
      text: o
        .toLowerCase()
        .replace(/^\(?[a-f][).]\s*/, '')
        .trim(),
    }))
    .filter((o) => o.text && a.includes(o.text));
  if (!hits.length) return null;
  // "Cash" and "Cash and bank" can both be found: the longest match is the one named.
  return hits.sort((x, y) => y.text.length - x.text.length)[0]!.i;
}

function prerequisitesOf(graph: ApprovedAsset | undefined, chapter: number, topic: string) {
  if (!graph) return [];
  const g = graph.content as StoredGraph;
  const byId = new Map<string, ConceptNode>(g.nodes.map((n) => [n.id, n]));
  const me = g.nodes.find((n) => n.chapter === chapter && same(n.topic, topic));
  if (!me) return [];
  return g.edges
    .filter((e) => e.to === me.id)
    .map((e) => byId.get(e.from))
    .filter((n): n is ConceptNode => !!n)
    .slice(0, 3)
    .map((n) => (n.chapter === chapter ? n.topic : `${n.topic} (ch. ${n.chapter})`));
}

export async function buildExplainPlan(
  db: Db,
  me: SessionUser,
  offeringId: string,
  chapterNo: number,
  topic: string,
): Promise<ExplainPlan> {
  const s = await strategyOf(db, offeringId);
  const ch = s.chapters.find((c) => c.no === chapterNo);
  if (!ch) throw notFound('Chapter');
  const assets = await approvedAssets(db, offeringId, chapterNo);
  const notes = assets
    .filter((a) => a.kind === 'note' && same(a.topic, topic))
    .sort((a, b) => a.marks - b.marks) as ApprovedAsset<StoredNote>[];
  const primary = notes[0];
  if (!primary) throw badRequest('This topic has no approved notes yet');
  const stat = ch.topics.find((t) => same(t.name, topic));
  const note = primary.content;

  // "Show the working": the worked exam answer of the topic's biggest note (6 or 12 marks).
  const big = [...notes]
    .reverse()
    .find((n) => marksTarget(n.marks).workedExample && n.content.examAnswer);
  const part = s.parts?.find((p) => p.marksEach === big?.marks);

  // Check question: from the approved question bank for this topic, smallest marks first; a
  // different one each time the learner comes back to the topic.
  const bank = (assets.filter((a) => a.kind === 'questions') as ApprovedAsset<QuestionSet>[])
    .sort((a, b) => a.marks - b.marks)
    .flatMap((set) =>
      set.content.questions
        .filter((q: GeneratedQuestion) => same(q.topic, topic))
        .map((q) => ({ q, marks: set.marks, sources: set.sources })),
    );
  const short = bank.filter((b) => b.marks <= 2);
  const pool = short.length ? short : bank;
  const before = await db
    .select({ n: count() })
    .from(studySessions)
    .where(
      and(
        eq(studySessions.userId, me.id),
        eq(studySessions.offeringId, offeringId),
        eq(studySessions.journey, 'explain'),
        eq(studySessions.chapter, chapterNo),
        eq(studySessions.topic, primary.topic),
      ),
    )
    .get();
  const picked = pool.length ? pool[(before?.n ?? 0) % pool.length]! : null;
  const check: ExplainPlan['check'] = picked
    ? {
        question: picked.q.question,
        marks: picked.marks,
        options: picked.q.options,
        correctOption: mcqCorrectIndex(picked.q.options, picked.q.answer),
        answer: picked.q.answer,
        markingPoints: picked.q.markingPoints,
        sources: picked.sources,
      }
    : note.examAnswer
      ? {
          question: note.examAnswer.question,
          marks: primary.marks,
          options: null,
          correctOption: null,
          answer: note.examAnswer.answer,
          markingPoints: [],
          sources: primary.sources,
        }
      : {
          question: `In one or two sentences: what is "${primary.topic}"?`,
          marks: 1,
          options: null,
          correctOption: null,
          answer: note.summary,
          markingPoints: [],
          sources: primary.sources,
        };

  const graph = (await approvedAssets(db, offeringId, 0)).find((a) => a.kind === 'graph');
  return {
    subject: `${s.board} ${s.className} ${s.subject}`,
    chapter: { no: ch.no, title: ch.title, marks: ch.marks },
    topic: primary.topic,
    asked: {
      marks: stat?.marks ?? [],
      examPapers: stat?.examPapers ?? 0,
      papers: s.exams?.papers ?? 0,
    },
    why: note.whyThisMatters,
    summary: note.summary,
    layers: note.sections.map((x) => ({ heading: x.heading, body: x.body })),
    keyTerms: note.keyTerms ?? [],
    working: big?.content.examAnswer
      ? {
          marks: big.marks,
          question: big.content.examAnswer.question,
          answer: big.content.examAnswer.answer,
          marksSplit: big.content.examAnswer.marksSplit,
          minutes:
            big.content.examAnswer.minutes ??
            examBudget(big.marks, part?.minutesPerQuestion).minutes,
          sources: big.sources,
        }
      : null,
    check,
    sources: primary.sources,
    prerequisites: prerequisitesOf(graph, chapterNo, primary.topic),
    interests: await interestsOf(db, me.id),
  };
}

// ---------------------------------------------------------------- memorise

export interface DeckCard extends Omit<RecallCard, 'box' | 'hook'> {
  box: number;
  dueAt: number | null;
  hook: string | null;
}

/** A chapter's cards for one learner: the platform's approved cards + their own, with review state. */
export async function chapterDeck(
  db: Db,
  userId: string,
  offeringId: string,
  chapterNo: number,
  assets?: ApprovedAsset[],
): Promise<DeckCard[]> {
  const all = assets ?? (await approvedAssets(db, offeringId, chapterNo));
  const set = all.find((a) => a.kind === 'cards' && a.chapter === chapterNo) as
    ApprovedAsset<CardsDraft> | undefined;
  const [mine, reviews] = await Promise.all([
    db
      .select()
      .from(learnerArtefacts)
      .where(
        and(
          eq(learnerArtefacts.userId, userId),
          eq(learnerArtefacts.offeringId, offeringId),
          eq(learnerArtefacts.chapter, chapterNo),
          eq(learnerArtefacts.status, 'active'),
        ),
      )
      .orderBy(learnerArtefacts.createdAt),
    db
      .select()
      .from(cardReviews)
      .where(
        and(
          eq(cardReviews.userId, userId),
          eq(cardReviews.offeringId, offeringId),
          eq(cardReviews.chapter, chapterNo),
        ),
      ),
  ]);
  const hooks = new Map<string, string>();
  for (const a of mine)
    if (a.kind === 'mnemonic' && a.cardKey && a.content.text) hooks.set(a.cardKey, a.content.text);
  const state = new Map(reviews.map((r) => [r.cardKey, r]));
  const base = [
    ...(set?.content.cards ?? []).map((c) => ({
      key: cardKey(set!.slotKey, c.front),
      topic: c.topic,
      // A recall card shows plain text: page markers would only be noise on it.
      front: stripCitations(c.front),
      back: stripCitations(c.back),
      own: false,
    })),
    ...mine
      .filter((a) => a.kind === 'card')
      .map((a) => ({
        key: ownCardKey(a.id),
        topic: a.topic || 'My card',
        front: a.content.front ?? '',
        back: a.content.back ?? '',
        own: true,
      })),
  ];
  const seen = new Set<string>();
  return base
    .filter((c) => c.front && !seen.has(c.key) && !!seen.add(c.key))
    .map((c) => ({
      ...c,
      box: state.get(c.key)?.box ?? 0,
      dueAt: state.get(c.key)?.dueAt.getTime() ?? null,
      hook: hooks.get(c.key) ?? null,
    }));
}

/** Today's cards: the ones due (longest overdue first), then new ones, up to the unit's size. */
export function todaysCards(deck: DeckCard[], now: number, size: number = MEMORISE_LIMITS.cards) {
  const due = deck
    .filter((c) => c.dueAt !== null && c.dueAt <= now)
    .sort((a, b) => a.dueAt! - b.dueAt!);
  const fresh = deck.filter((c) => c.dueAt === null);
  const picked = [...due, ...fresh].slice(0, size);
  return {
    cards: picked,
    due: picked.filter((c) => c.dueAt !== null).length,
    fresh: picked.filter((c) => c.dueAt === null).length,
    dueTotal: due.length,
    freshTotal: fresh.length,
  };
}

export async function buildMemorisePlan(
  db: Db,
  me: SessionUser,
  offeringId: string,
  chapterNo: number,
  now: number,
): Promise<MemorisePlan> {
  const s = await strategyOf(db, offeringId);
  const ch = s.chapters.find((c) => c.no === chapterNo);
  if (!ch) throw notFound('Chapter');
  const assets = await approvedAssets(db, offeringId, chapterNo);
  const deck = await chapterDeck(db, me.id, offeringId, chapterNo, assets);
  if (!deck.length) throw badRequest('This chapter has no approved cards yet');
  const today = todaysCards(deck, now);
  if (!today.cards.length)
    throw badRequest('No cards are due in this chapter today. They come back on their own days.');

  // One timed write-out: a short exam answer (1–2 marks first), a different one each session.
  const notes = (assets.filter((a) => a.kind === 'note') as ApprovedAsset<StoredNote>[])
    .filter((n) => n.content.examAnswer?.answer)
    .sort((a, b) => a.marks - b.marks);
  const shortNotes = notes.filter((n) => n.marks <= 2);
  const pool = shortNotes.length ? shortNotes : notes;
  const before = await db
    .select({ n: count() })
    .from(studySessions)
    .where(
      and(
        eq(studySessions.userId, me.id),
        eq(studySessions.offeringId, offeringId),
        eq(studySessions.journey, 'memorise'),
        eq(studySessions.chapter, chapterNo),
      ),
    )
    .get();
  const w = pool.length ? pool[(before?.n ?? 0) % pool.length]! : null;
  const part = s.parts?.find((p) => p.marksEach === w?.marks);

  return {
    subject: `${s.board} ${s.className} ${s.subject}`,
    chapter: { no: ch.no, title: ch.title, marks: ch.marks },
    cards: today.cards.map((c) => ({
      key: c.key,
      topic: c.topic,
      front: c.front,
      back: c.back,
      own: c.own,
      box: c.box,
      hook: c.hook,
    })),
    due: today.due,
    fresh: today.fresh,
    total: deck.length,
    writeOut: w
      ? {
          topic: w.topic,
          marks: w.marks,
          minutes:
            w.content.examAnswer!.minutes ?? examBudget(w.marks, part?.minutesPerQuestion).minutes,
          question: w.content.examAnswer!.question,
          answer: w.content.examAnswer!.answer,
          marksSplit: w.content.examAnswer!.marksSplit,
          sources: w.sources,
        }
      : null,
    interests: await interestsOf(db, me.id),
  };
}
