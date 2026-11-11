import {
  CARD_LIMITS,
  cardsDraftSchema,
  critiqueSchema,
  slotKey,
  type AssetCheck,
  type AssetSource,
  type CardsDraft,
  type ExamStrategy,
  type StoredNote,
} from '@aicoach/core';
import { examStrategies, learningAssets, type Db } from '@aicoach/db';
import { and, desc, eq, ne } from 'drizzle-orm';
import { retrieve, type Source } from '../content/retrieve';
import { platformWallet } from '../credits/wallets';
import type { Env } from '../env';
import { askJson } from '../llm/json';
import { words } from './checks';
import { needsFix, reviewerIssue, saveVersion, textbookTags, type SlotRef } from './shared';

/**
 * Chapter memory map + quick reference cards (architecture §7 Phase 3, spec 2.4). One asset per
 * chapter (slot `cards:<chapter>:<title>:0`). Cards are what students memorise (decision 9.5-5):
 * definitions, formulas, formats, rules, differences, key facts; concise, each citing the textbook.
 * Same pipeline as notes: writer → critic → fixer (only when asked) → code checks → draft version.
 */

export const CARDS_PROMPT_VERSION = 'cards@1';

export interface CardSlot extends SlotRef {
  chapterTitle: string;
}

export function planCardSlots(s: ExamStrategy, chapters: number[] | null): CardSlot[] {
  return s.chapters
    .filter((c) => !chapters || chapters.includes(c.no))
    .map((c) => ({
      key: slotKey('cards', c.no, c.title, 0),
      chapter: c.no,
      chapterTitle: c.title,
      topic: c.title,
      marks: 0,
    }));
}

export interface CardsContext {
  board: string;
  className: string;
  subject: string;
  chapter: number;
  chapterTitle: string;
  marks: number;
  parts: string[];
  topics: { name: string; examPapers: number; marks: number[] }[];
  /** Digest of the chapter's notes (when generated): what each topic's note says matters. */
  notes: { topic: string; marks: number; summary: string; keyTerms: string[] }[];
  conventions: { format: string; rule: string }[];
  excerpts: { n: number; page: number; section: string | null; text: string }[];
}

const JSON_ONLY = 'Reply with ONE JSON object only (no Markdown fences, no commentary).';
const L = CARD_LIMITS;

const contextText = (c: CardsContext) =>
  [
    `Subject: ${c.board} ${c.className} ${c.subject}`,
    `Chapter ${c.chapter}: ${c.chapterTitle} (${c.marks} marks in the blueprint; asked in part${c.parts.length === 1 ? '' : 's'} ${c.parts.join(', ') || '?'})`,
    `Topics (with how many board papers asked them, and at which marks):\n${c.topics
      .map((t) => `- ${t.name} (${t.examPapers} papers; ${t.marks.join('/') || '1'} marks)`)
      .join('\n')}`,
    c.notes.length
      ? `What the chapter's study notes stress:\n${c.notes
          .map(
            (n) =>
              `- ${n.topic} (${n.marks}m): ${n.summary}${n.keyTerms.length ? ` | key terms: ${n.keyTerms.join(', ')}` : ''}`,
          )
          .join('\n')}`
      : '',
    c.conventions.length
      ? `Presentation rules from centum scripts:\n${c.conventions.map((r) => `- (${r.format}) ${r.rule}`).join('\n')}`
      : '',
    `Textbook excerpts (cite as S#):\n\n${c.excerpts
      .map((e) => `[S${e.n}] (page ${e.page}${e.section ? `, ${e.section}` : ''})\n${e.text}`)
      .join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');

const SHAPE =
  '{"title":"...","map":{"center":"chapter","branches":[{"label":"...","topic":"topic name from the list","points":["short point"]}]},"cards":[{"topic":"topic name from the list","type":"definition|formula|format|rule|difference|fact","front":"question or cue","back":"answer","cite":"S3"}]}';

export const CARDS_WRITER_PROMPT = {
  system: [
    'You make a memory map and quick revision cards for one chapter, for students revising for their board exam. Cards are what students memorise: definitions, formulas, formats (e.g. the columns of an account), rules, differences, key facts.',
    JSON_ONLY,
    `Shape: ${SHAPE}`,
    'Rules:',
    '- Everything comes ONLY from the textbook excerpts; every card cites the excerpt it comes from in "cite" (e.g. "S3"). Never invent figures or rules.',
    `- ${L.minCards}–${L.maxCards} cards. Each front at most ${L.frontWords} words (a question or cue), each back at most ${L.backWords} words (the exact answer an examiner looks for). One idea per card.`,
    '- Cover every topic in the list at least once; more cards for topics asked in more papers. Use the topic names exactly as listed.',
    '- Formulas in plain text ("Gaining Ratio = New Ratio − Old Ratio"). Amounts in ₹ with Indian grouping.',
    `- The memory map: the chapter at the centre, at most ${L.maxBranches} branches (one per main topic or group of topics), each with at most ${L.maxPoints} points of at most ${L.pointWords} words; it should show how the chapter fits together at a glance.`,
  ].join('\n'),
  user: (c: CardsContext) => contextText(c),
} as const;

export const CARDS_CRITIC_PROMPT = {
  system: [
    'You are a strict senior examiner reviewing revision cards and a memory map written for students. Find real problems; do not rewrite them.',
    JSON_ONLY,
    'Shape: {"scores":{"accuracy":1-5,"grounded":1-5,"marksFit":1-5,"presentation":1-5,"clarity":1-5},"issues":[{"severity":"major|minor","where":"card N or the map","problem":"...","fix":"..."}],"verdict":"pass|fix"}',
    '- accuracy: every definition, formula and fact is right (recompute any formula example). An error is a major issue.',
    '- grounded: each card is backed by the excerpt it cites; anything not in the excerpts is a major issue.',
    '- marksFit: the cards cover the exam-relevant topics (more for topics asked often), one idea per card, answers as an examiner wants them.',
    '- presentation: concise (short fronts and backs), formats named as the board names them; the map shows how the chapter fits together.',
    '- clarity: a student can revise from them quickly.',
    'verdict "fix" when there is any major issue or any score below 4; otherwise "pass".',
  ].join('\n'),
  user: (c: CardsContext, cards: string) =>
    `${contextText(c)}\n\nThe cards and memory map to review (JSON):\n${cards}`,
} as const;

export const CARDS_FIXER_PROMPT = {
  system: [
    CARDS_WRITER_PROMPT.system,
    'You are given a draft and an examiner review. Return the corrected cards and map: fix every major issue and the minor ones that are right; keep what is already correct.',
  ].join('\n'),
  user: (c: CardsContext, cards: string, issues: string) =>
    `${contextText(c)}\n\nDraft (JSON):\n${cards}\n\nExaminer review:\n${issues}`,
} as const;

// ------------------------------------------------------------------ checks

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export function cardsChecks(d: CardsDraft, topics: string[], sourceCount: number): AssetCheck[] {
  const checks: AssetCheck[] = [];
  const n = d.cards.length;
  checks.push({
    name: 'Number of cards',
    ok: n >= L.minCards && n <= L.maxCards,
    detail: `${n} cards (${L.minCards}–${L.maxCards})`,
  });
  const cites = d.cards.map((c) => Number(/^\[?S(\d+)\]?$/i.exec(c.cite?.trim() ?? '')?.[1] ?? 0));
  const uncited = cites.filter((x) => x < 1 || x > sourceCount).length;
  checks.push({
    name: 'Every card cites the textbook',
    ok: uncited === 0,
    detail: uncited ? `${uncited} of ${n} cards without a valid citation` : `${n} of ${n} cited`,
  });
  const longFront = d.cards.filter((c) => words(c.front) > L.frontWords * 1.25).length;
  const longBack = d.cards.filter((c) => words(c.back) > L.backWords * 1.25).length;
  checks.push({
    name: 'Cards are concise',
    ok: longFront + longBack === 0,
    detail:
      longFront + longBack
        ? `${longFront} long fronts, ${longBack} long backs (front ≤ ${L.frontWords}, back ≤ ${L.backWords} words)`
        : `fronts ≤ ${L.frontWords}, backs ≤ ${L.backWords} words`,
  });
  const covered = new Set(d.cards.map((c) => norm(c.topic)));
  const missing = topics.filter((t) => !covered.has(norm(t)));
  checks.push({
    name: 'Every topic has a card',
    ok: missing.length === 0,
    detail: missing.length
      ? `no card for: ${missing.slice(0, 5).join('; ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}`
      : `${topics.length} topics covered`,
  });
  const b = d.map.branches;
  const crowded = b.filter(
    (x) => x.points.length > L.maxPoints || x.points.some((p) => words(p) > L.pointWords * 1.25),
  ).length;
  checks.push({
    name: 'Memory map fits one screen',
    ok: b.length <= L.maxBranches && crowded === 0,
    detail: `${b.length} branches${crowded ? `, ${crowded} with too many or too long points` : ''}`,
  });
  return checks;
}

// ------------------------------------------------------------------ generate

const MAX_EXCERPTS = 18;

async function cardsContext(
  env: Env,
  db: Db,
  offeringId: string,
  s: ExamStrategy,
  slot: CardSlot,
  tags: string[],
): Promise<{ ctx: CardsContext; sources: AssetSource[] }> {
  const ch = s.chapters.find((c) => c.no === slot.chapter);
  const topics = ch?.topics ?? [];
  // Two excerpts per topic (most-asked first), merged and renumbered.
  const found: Source[] = [];
  const seen = new Set<string>();
  const queries = [
    slot.chapterTitle,
    ...[...topics].sort((a, b) => b.examPapers - a.examPapers).map((t) => t.name),
  ];
  for (const q of queries) {
    if (found.length >= MAX_EXCERPTS) break;
    const hits = await retrieve(env, db, `${q} (${slot.chapterTitle})`, tags, { topK: 2 });
    for (const h of hits)
      if (!seen.has(h.chunkId) && found.length < MAX_EXCERPTS) {
        seen.add(h.chunkId);
        found.push({ ...h, n: found.length + 1 });
      }
  }
  // Newest non-rejected note per slot of this chapter.
  const noteRows = await db
    .select({
      slotKey: learningAssets.slotKey,
      topic: learningAssets.topic,
      marks: learningAssets.marks,
      content: learningAssets.content,
    })
    .from(learningAssets)
    .where(
      and(
        eq(learningAssets.offeringId, offeringId),
        eq(learningAssets.kind, 'note'),
        eq(learningAssets.chapter, slot.chapter),
        ne(learningAssets.status, 'rejected'),
        ne(learningAssets.status, 'superseded'),
      ),
    )
    .orderBy(desc(learningAssets.version));
  const bySlot = new Map<string, (typeof noteRows)[number]>();
  for (const r of noteRows) if (!bySlot.has(r.slotKey)) bySlot.set(r.slotKey, r);
  const notes = [...bySlot.values()].slice(0, 30).map((r) => {
    const c = r.content as StoredNote;
    return {
      topic: r.topic,
      marks: r.marks,
      summary: (c.summary ?? '').replace(/\[S\d+\]/g, '').slice(0, 300),
      keyTerms: (c.keyTerms ?? []).slice(0, 6),
    };
  });
  return {
    ctx: {
      board: s.board,
      className: s.className,
      subject: s.subject,
      chapter: slot.chapter,
      chapterTitle: slot.chapterTitle,
      marks: ch?.marks ?? 0,
      parts: (['A', 'B', 'C', 'D'] as const).filter((p) => (ch?.[`part${p}` as 'partA'] ?? 0) > 0),
      topics: topics.map((t) => ({ name: t.name, examPapers: t.examPapers, marks: t.marks })),
      notes,
      conventions: (s.answerConventions ?? [])
        .slice(0, 12)
        .map((c) => ({ format: c.format, rule: c.rule })),
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

const MAX_TOKENS = 8000;

/** Writes one chapter's cards + memory map as a new draft version. Returns its cost (nano-USD). */
export async function generateCards(
  env: Env,
  db: Db,
  run: { id: string; userId: string; offeringId: string; strategyId: string },
  s: ExamStrategy,
  slot: CardSlot,
  tags: string[],
) {
  const payers = [await platformWallet(db)];
  const { ctx, sources } = await cardsContext(env, db, run.offeringId, s, slot, tags);
  const common = { payers, userId: run.userId, thinking: 'off' as const };
  const draft = await askJson(env, db, {
    ...common,
    task: 'content_generation',
    schema: cardsDraftSchema,
    system: CARDS_WRITER_PROMPT.system,
    user: CARDS_WRITER_PROMPT.user(ctx),
    maxTokens: MAX_TOKENS,
  });
  const review = await askJson(env, db, {
    ...common,
    task: 'content_review',
    schema: critiqueSchema,
    system: CARDS_CRITIC_PROMPT.system,
    user: CARDS_CRITIC_PROMPT.user(ctx, JSON.stringify(draft.value)),
    maxTokens: 2500,
  });
  let cards = draft.value;
  let cost = draft.costUsdNano + review.costUsdNano;
  const fixed = needsFix(review.value);
  if (fixed) {
    const fix = await askJson(env, db, {
      ...common,
      task: 'content_generation',
      schema: cardsDraftSchema,
      system: CARDS_FIXER_PROMPT.system,
      user: CARDS_FIXER_PROMPT.user(ctx, JSON.stringify(draft.value), JSON.stringify(review.value)),
      maxTokens: MAX_TOKENS,
    });
    cards = fix.value;
    cost += fix.costUsdNano;
  }
  await saveVersion(db, {
    kind: 'cards',
    promptVersion: CARDS_PROMPT_VERSION,
    run: { id: run.id, offeringId: run.offeringId, strategyId: run.strategyId },
    slot,
    content: cards,
    critique: { ...review.value, fixedAfter: fixed },
    fixed,
    checks: cardsChecks(
      cards,
      ctx.topics.map((t) => t.name),
      sources.length,
    ),
    sources,
    cost,
  });
  return cost;
}

/** "Rewrite with my comment" for a chapter's cards (see rewriteNote). */
export async function rewriteCards(
  env: Env,
  db: Db,
  asset: typeof learningAssets.$inferSelect,
  comment: string,
  userId: string,
) {
  if (!asset.strategyId) throw new Error('These cards have no strategy to follow');
  const strat = await db
    .select()
    .from(examStrategies)
    .where(eq(examStrategies.id, asset.strategyId))
    .get();
  if (!strat?.strategy) throw new Error('The strategy these cards follow has no content');
  const s = strat.strategy as ExamStrategy;
  const tags = await textbookTags(db, asset.offeringId);
  if (!tags.length) throw new Error('No published textbook for this subject');
  const slot: CardSlot = {
    key: asset.slotKey,
    chapter: asset.chapter,
    chapterTitle: s.chapters.find((c) => c.no === asset.chapter)?.title ?? asset.topic,
    topic: asset.topic,
    marks: asset.marks,
  };
  const payers = [await platformWallet(db)];
  const { ctx, sources } = await cardsContext(env, db, asset.offeringId, s, slot, tags);
  const common = { payers, userId, thinking: 'off' as const };
  const fix = await askJson(env, db, {
    ...common,
    task: 'content_generation',
    schema: cardsDraftSchema,
    system: CARDS_FIXER_PROMPT.system,
    user: CARDS_FIXER_PROMPT.user(ctx, JSON.stringify(asset.content), reviewerIssue(comment)),
    maxTokens: MAX_TOKENS,
  });
  const review = await askJson(env, db, {
    ...common,
    task: 'content_review',
    schema: critiqueSchema,
    system: CARDS_CRITIC_PROMPT.system,
    user: CARDS_CRITIC_PROMPT.user(ctx, JSON.stringify(fix.value)),
    maxTokens: 2500,
  });
  return saveVersion(db, {
    kind: 'cards',
    promptVersion: CARDS_PROMPT_VERSION,
    run: { id: null, offeringId: asset.offeringId, strategyId: asset.strategyId },
    slot,
    content: fix.value,
    critique: { ...review.value, fixedAfter: false },
    fixed: true,
    checks: cardsChecks(
      fix.value,
      ctx.topics.map((t) => t.name),
      sources.length,
    ),
    sources,
    cost: fix.costUsdNano + review.costUsdNano,
    reject: asset.status === 'draft' ? { id: asset.id, comment, by: userId } : undefined,
  });
}
