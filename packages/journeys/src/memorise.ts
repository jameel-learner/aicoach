import {
  edges,
  type AssetSource,
  type Checkpoint,
  type Graph,
  type JourneyView,
  type RecallRating,
  type ViewAction,
  type ViewBlock,
  type ViewForm,
} from '@aicoach/core';
import { clock, handoffBlocks, plural, reduceScopeView, type Notified } from './copy';

/**
 * Memorisation journey (architecture §3.7, §7 Phase 4), one chapter's cards per session:
 *   today's cards (due ones first, then new) → recall → check → rate yourself → …
 *   → optionally make a memory hook for a card (mnemonic co-creation)
 *   → one timed write-out on paper (spec 2.2.1) → close.
 * A forgotten card comes back once at the end (retry without penalty).
 */

export type MemoriseNode =
  | 'brief'
  | 'recall'
  | 'reveal'
  | 'mnemonic'
  | 'write_out'
  | 'writing'
  | 'write_check'
  | 'reduce_scope'
  | 'micro_win'
  | 'safety';

export interface RecallCard {
  key: string;
  topic: string;
  front: string;
  back: string;
  /** The learner wrote it. */
  own: boolean;
  /** Leitner box before this session (0 = new). */
  box: number;
  /** The learner's saved memory hook for it, if any. */
  hook: string | null;
}

export interface MemorisePlan {
  subject: string;
  chapter: { no: number; title: string; marks: number };
  /** Today's cards in order. */
  cards: RecallCard[];
  due: number;
  fresh: number;
  /** Cards of the chapter in all (platform + own). */
  total: number;
  writeOut: {
    topic: string;
    marks: number;
    minutes: number;
    question: string;
    answer: string;
    marksSplit: string | null;
    sources: AssetSource[];
  } | null;
  interests: string[];
}

export type WriteSelf = 'all' | 'most' | 'some';

export interface MemoriseState {
  plan: MemorisePlan;
  reduced: boolean;
  returnTo: MemoriseNode | null;
  /** Card keys in the order they come up (a forgotten card is appended once). */
  queue: string[];
  pos: number;
  repeated: string[];
  ratings: { key: string; rating: RecallRating; at: number }[];
  /** The hook being made (at the mnemonic step). */
  hooking: { key: string; ideas: string[]; rounds: number } | null;
  hooks: { key: string; text: string; artefactId: string }[];
  write: { startedAt: number; finishedAt: number | null; self: WriteSelf | null } | null;
  stopped: boolean;
  handoff: Notified | null;
}

export type MemoriseEvent =
  | { type: 'start' }
  | { type: 'too_much' }
  | { type: 'show' }
  | { type: 'rated'; rating: RecallRating; at: number }
  | { type: 'make_hook' }
  | { type: 'ideas'; ideas: string[] }
  | { type: 'hook_saved'; text: string; artefactId: string }
  | { type: 'back' }
  | { type: 'begin_writing'; at: number }
  | { type: 'done_writing'; at: number }
  | { type: 'self_checked'; self: WriteSelf }
  | { type: 'skip_writing' }
  | { type: 'continue_small' }
  | { type: 'continue_full' }
  | { type: 'stop_here' }
  | { type: 'distress'; notified: Notified };

export const MEMORISE_LIMITS = { cards: 8, reducedCards: 3, ideaRounds: 2 } as const;

export const memoriseStart = (plan: MemorisePlan): MemoriseState => ({
  plan,
  reduced: false,
  returnTo: null,
  queue: plan.cards.map((c) => c.key),
  pos: 0,
  repeated: [],
  ratings: [],
  hooking: null,
  hooks: [],
  write: null,
  stopped: false,
  handoff: null,
});

export const currentKey = (s: MemoriseState) => s.queue[s.pos] ?? null;
export const currentCard = (s: MemoriseState) =>
  s.plan.cards.find((c) => c.key === currentKey(s)) ?? null;
export const hookFor = (s: MemoriseState, key: string) =>
  s.hooks.findLast((h) => h.key === key)?.text ??
  s.plan.cards.find((c) => c.key === key)?.hook ??
  null;
export const canAskIdeas = (s: MemoriseState) =>
  !!s.hooking && s.hooking.rounds < MEMORISE_LIMITS.ideaRounds;
/** True when this card already came up in this session (so a "got it" can't move it up twice). */
export const isRepeat = (s: MemoriseState) => {
  const key = currentKey(s);
  return !!key && s.ratings.some((r) => r.key === key);
};

const comesBack = (s: MemoriseState, rating: RecallRating) => {
  const key = currentKey(s);
  return rating === 'forgot' && !s.reduced && !!key && !s.repeated.includes(key);
};
const moreAfter = (s: MemoriseState, rating: RecallRating) =>
  s.pos + 1 < s.queue.length + (comesBack(s, rating) ? 1 : 0);

function rate(s: MemoriseState, ev: Extract<MemoriseEvent, { type: 'rated' }>): MemoriseState {
  const key = currentKey(s)!;
  const back = comesBack(s, ev.rating);
  return {
    ...s,
    ratings: [...s.ratings, { key, rating: ev.rating, at: ev.at }],
    queue: back ? [...s.queue, key] : s.queue,
    repeated: back ? [...s.repeated, key] : s.repeated,
    pos: s.pos + 1,
  };
}

const e = edges<MemoriseState, MemoriseEvent, MemoriseNode>();
const PAUSABLE = ['brief', 'recall', 'reveal', 'mnemonic', 'write_out', 'writing'] as const;

export const memoriseGraph: Graph<MemoriseState, MemoriseEvent, MemoriseNode> = {
  id: 'memorise',
  version: 1,
  start: 'brief',
  nodes: {
    brief: {},
    recall: {},
    reveal: {},
    mnemonic: {},
    write_out: {},
    writing: {},
    write_check: {},
    reduce_scope: {},
    micro_win: { terminal: true },
    safety: { terminal: true },
  },
  edges: [
    e({ id: 'brief.start', from: 'brief', on: 'start', to: 'recall' }),
    e({ id: 'recall.show', from: 'recall', on: 'show', to: 'reveal' }),

    e({
      id: 'reveal.rated.next',
      from: 'reveal',
      on: 'rated',
      to: 'recall',
      guard: (s, ev) => moreAfter(s, ev.rating),
      apply: rate,
    }),
    e({
      id: 'reveal.rated.write',
      from: 'reveal',
      on: 'rated',
      to: 'write_out',
      guard: (s) => !!s.plan.writeOut && !s.reduced,
      apply: rate,
    }),
    e({ id: 'reveal.rated.done', from: 'reveal', on: 'rated', to: 'micro_win', apply: rate }),

    // Memory hook for the card on screen: the learner's own words, with ideas on request.
    e({
      id: 'reveal.hook',
      from: 'reveal',
      on: 'make_hook',
      to: 'mnemonic',
      apply: (s) => ({ ...s, hooking: { key: currentKey(s)!, ideas: [], rounds: 0 } }),
    }),
    e({
      id: 'mnemonic.ideas',
      from: 'mnemonic',
      on: 'ideas',
      to: 'mnemonic',
      guard: canAskIdeas,
      apply: (s, ev) => ({
        ...s,
        hooking: { ...s.hooking!, ideas: ev.ideas, rounds: s.hooking!.rounds + 1 },
      }),
    }),
    e({
      id: 'mnemonic.saved',
      from: 'mnemonic',
      on: 'hook_saved',
      to: 'reveal',
      apply: (s, ev) => ({
        ...s,
        hooks: [...s.hooks, { key: s.hooking!.key, text: ev.text, artefactId: ev.artefactId }],
        hooking: null,
      }),
    }),
    e({
      id: 'mnemonic.back',
      from: 'mnemonic',
      on: 'back',
      to: 'reveal',
      apply: (s) => ({ ...s, hooking: null }),
    }),

    // Timed write-out, on paper: the clock is the point (spec 2.2.1).
    e({
      id: 'write.begin',
      from: 'write_out',
      on: 'begin_writing',
      to: 'writing',
      apply: (s, ev) => ({ ...s, write: { startedAt: ev.at, finishedAt: null, self: null } }),
    }),
    e({ id: 'write.skip', from: 'write_out', on: 'skip_writing', to: 'micro_win' }),
    e({
      id: 'writing.done',
      from: 'writing',
      on: 'done_writing',
      to: 'write_check',
      apply: (s, ev) => ({ ...s, write: { ...s.write!, finishedAt: ev.at } }),
    }),
    e({
      id: 'write_check.checked',
      from: 'write_check',
      on: 'self_checked',
      to: 'micro_win',
      apply: (s, ev) => ({ ...s, write: { ...s.write!, self: ev.self } }),
    }),

    ...PAUSABLE.map((n) =>
      e({
        id: `${n}.too_much`,
        from: n,
        on: 'too_much',
        to: 'reduce_scope',
        apply: (s) => ({ ...s, returnTo: n }),
      }),
    ),
    // Smaller plan: at most three more cards, no repeats, no write-out.
    e({
      id: 'reduce.small.recall',
      from: 'reduce_scope',
      on: 'continue_small',
      to: 'recall',
      guard: (s) => s.pos < s.queue.length,
      apply: (s) => ({
        ...s,
        reduced: true,
        returnTo: null,
        hooking: null,
        queue: s.queue.slice(0, s.pos + MEMORISE_LIMITS.reducedCards),
      }),
    }),
    e({
      id: 'reduce.small.finish',
      from: 'reduce_scope',
      on: 'continue_small',
      to: 'micro_win',
      apply: (s) => ({ ...s, reduced: true, returnTo: null }),
    }),
    ...PAUSABLE.map((n) =>
      e({
        id: `reduce.full.${n}`,
        from: 'reduce_scope',
        on: 'continue_full',
        to: n,
        guard: (s) => s.returnTo === n,
        apply: (s) => ({ ...s, returnTo: null }),
      }),
    ),
    e({
      id: 'reduce.stop',
      from: 'reduce_scope',
      on: 'stop_here',
      to: 'micro_win',
      apply: (s) => ({ ...s, stopped: true, returnTo: null }),
    }),

    e({
      id: 'any.distress',
      from: '*',
      on: 'distress',
      to: 'safety',
      apply: (s, ev) => ({ ...s, handoff: ev.notified }),
    }),
  ],
};

// ---------------------------------------------------------------- outcome

export interface MemoriseOutcome {
  cards: number;
  got: number;
  almost: number;
  forgot: number;
  hooks: number;
  write: { seconds: number; targetMinutes: number; self: WriteSelf | null } | null;
  stopped: boolean;
}

/** Counts each card once, by its LAST rating in the session. */
export function memoriseOutcome(s: MemoriseState): MemoriseOutcome {
  const last = new Map<string, RecallRating>();
  for (const r of s.ratings) last.set(r.key, r.rating);
  const count = (x: RecallRating) => [...last.values()].filter((r) => r === x).length;
  const w = s.write;
  return {
    cards: last.size,
    got: count('got'),
    almost: count('almost'),
    forgot: count('forgot'),
    hooks: new Set(s.hooks.map((h) => h.key)).size,
    write:
      w?.finishedAt && s.plan.writeOut
        ? {
            seconds: Math.round((w.finishedAt - w.startedAt) / 1000),
            targetMinutes: s.plan.writeOut.minutes,
            self: w.self,
          }
        : null,
    stopped: s.stopped,
  };
}

// ---------------------------------------------------------------- view

const TOO_MUCH: ViewAction = { id: 'too_much', label: 'This is too much today', style: 'link' };

function cardBlock(s: MemoriseState, withBack: boolean): ViewBlock[] {
  const c = currentCard(s) ?? s.plan.cards.find((x) => x.key === s.hooking?.key);
  if (!c) return [];
  const hook = hookFor(s, c.key);
  return [
    {
      type: 'card',
      label: `${c.topic}${c.own ? ' · your card' : ''}`,
      front: c.front,
      ...(withBack ? { back: c.back } : {}),
    },
    ...(withBack && hook
      ? [{ type: 'callout', tone: 'info', title: 'Your memory hook', text: hook } as const]
      : []),
  ];
}

export function memoriseView(
  cp: Checkpoint<MemoriseState, MemoriseNode>,
  now: number,
): JourneyView {
  const s = cp.state;
  const p = s.plan;
  const node = cp.node;
  const n = s.queue.length;
  const base = {
    title: `${p.chapter.no}. ${p.chapter.title}`,
    subtitle: 'Memorise · quick cards',
    progress:
      node === 'write_out' || node === 'writing' || node === 'write_check'
        ? { step: n, of: n, label: 'Write-out' }
        : { step: Math.min(s.pos + (node === 'brief' ? 0 : 1), n), of: n, label: 'Cards' },
  };
  const view = (blocks: ViewBlock[], actions: ViewAction[] = [], forms: ViewForm[] = []) => ({
    ...base,
    blocks,
    actions,
    forms,
  });
  const w = p.writeOut;

  switch (node) {
    case 'brief':
      return view(
        [
          {
            type: 'badges',
            items: [
              { label: `${plural(n, 'card')} today`, strong: true },
              { label: `Chapter: ${p.chapter.marks} marks` },
            ],
          },
          {
            type: 'text',
            text: `${p.due} due for review, ${p.fresh} new. The chapter has ${plural(p.total, 'card')} in all.`,
          },
          {
            type: 'text',
            text: 'How it works: a card you know comes back after 3 days, then 7, 16 and 35. One you forget comes back tomorrow. Nothing is lost by getting one wrong.',
            muted: true,
          },
          ...(w
            ? [
                {
                  type: 'text',
                  text: `Then one timed write-out on paper (${w.minutes} min), like in the exam.`,
                  muted: true,
                } as const,
              ]
            : []),
        ],
        [
          { id: 'start', label: 'Start', style: 'primary' },
          { id: 'too_much', label: 'Not up to this today', style: 'link' },
        ],
      );
    case 'recall':
      return view(
        [
          ...cardBlock(s, false),
          {
            type: 'text',
            text: isRepeat(s)
              ? 'This one again, because it slipped earlier. Say the answer, then check.'
              : 'Say the answer in your head or out loud, then check.',
            muted: true,
          },
        ],
        [{ id: 'show', label: 'Show the answer', style: 'primary' }, TOO_MUCH],
      );
    case 'reveal':
      return view(cardBlock(s, true), [
        { id: 'rate', label: 'I knew it', style: 'primary', value: 'got' },
        { id: 'rate', label: 'Almost', style: 'secondary', value: 'almost' },
        { id: 'rate', label: 'Forgot', style: 'secondary', value: 'forgot' },
        {
          id: 'hook',
          label: hookFor(s, currentKey(s) ?? '') ? 'Change my memory hook' : 'Make a memory hook',
          style: 'link',
        },
        TOO_MUCH,
      ]);
    case 'mnemonic': {
      const ideas = s.hooking?.ideas ?? [];
      return view(
        [
          ...cardBlock(s, true),
          {
            type: 'text',
            text: 'A memory hook is a silly phrase, picture or story that ties the answer to something you already know. Your own works better than ours.',
            muted: true,
          },
          ...(ideas.length
            ? [
                {
                  type: 'text',
                  text: 'Ideas to start from (change them to make them yours):',
                } as const,
                { type: 'list', items: ideas } as const,
              ]
            : []),
        ],
        [
          ...ideas.map((_idea, i): ViewAction => ({
            id: 'use_idea',
            label: `Use idea ${i + 1}`,
            style: 'secondary',
            value: i,
          })),
          { id: 'back', label: 'Skip', style: 'link' },
          TOO_MUCH,
        ],
        [
          {
            id: 'hook',
            fields: [
              {
                name: 'text',
                label: 'Your memory hook',
                placeholder: 'A phrase, a picture, a story…',
                multiline: true,
              },
            ],
            submits: [
              { action: 'save_hook', label: 'Save my hook', style: 'primary' },
              ...(canAskIdeas(s)
                ? [{ action: 'ideas', label: 'Give me ideas', style: 'secondary' } as const]
                : []),
            ],
          },
        ],
      );
    }
    case 'write_out':
      return view(
        [
          { type: 'heading', text: 'Write it out, like in the exam' },
          {
            type: 'badges',
            items: [
              { label: plural(w!.marks, 'mark'), strong: true },
              { label: `${w!.minutes} min in the paper` },
            ],
          },
          { type: 'markdown', text: `**${w!.question}**` },
          {
            type: 'text',
            text: "Write the answer on paper, from memory. Start the clock when you're ready.",
            muted: true,
          },
        ],
        [
          { id: 'write', label: 'Start the clock', style: 'primary' },
          { id: 'skip', label: 'Skip the write-out', style: 'link' },
          TOO_MUCH,
        ],
      );
    case 'writing':
      return view(
        [
          { type: 'markdown', text: `**${w!.question}**` },
          {
            type: 'timer',
            elapsedMs: Math.max(0, now - (s.write?.startedAt ?? now)),
            targetMinutes: w!.minutes,
          },
        ],
        [{ id: 'done_writing', label: "I've finished writing", style: 'primary' }, TOO_MUCH],
      );
    case 'write_check': {
      const took = (s.write?.finishedAt ?? now) - (s.write?.startedAt ?? now);
      const over = took - w!.minutes * 60_000;
      return view(
        [
          {
            type: 'callout',
            tone: 'info',
            title: `You took ${clock(took)}`,
            text:
              over <= 0
                ? `The paper allows about ${w!.minutes} min for this, so you were inside the time.`
                : `The paper allows about ${w!.minutes} min for this, so you were ${clock(over)} over. Speed comes with repeats.`,
          },
          {
            type: 'heading',
            text: `Model answer${w!.marksSplit ? ` · marks ${w!.marksSplit}` : ''}`,
          },
          { type: 'markdown', text: w!.answer, sources: w!.sources },
          { type: 'text', text: 'Compare it with what you wrote. How much did you have?' },
        ],
        [
          { id: 'self_check', label: 'All of it', style: 'primary', value: 'all' },
          { id: 'self_check', label: 'Most of it', style: 'secondary', value: 'most' },
          { id: 'self_check', label: 'Not much yet', style: 'secondary', value: 'some' },
        ],
      );
    }
    case 'reduce_scope':
      return reduceScopeView(
        base,
        s.pos < s.queue.length
          ? `Just ${plural(Math.min(MEMORISE_LIMITS.reducedCards, s.queue.length - s.pos), 'more card')}, then done`
          : 'Finish now',
      );
    case 'micro_win': {
      const o = memoriseOutcome(s);
      const selfText: Record<WriteSelf, string> = {
        all: 'you had all of it',
        most: 'you had most of it',
        some: 'not much of it yet',
      };
      const lines = [
        o.cards
          ? `You went through ${plural(o.cards, 'card')}: ${o.got} you knew, ${o.almost} almost, ${o.forgot} forgotten.`
          : 'No cards today.',
        o.forgot + o.almost
          ? `${plural(o.forgot + o.almost, 'card')} will come back tomorrow.`
          : null,
        o.hooks ? `You made ${plural(o.hooks, 'memory hook')}. They are in your locker.` : null,
        o.write
          ? `Write-out: ${clock(o.write.seconds * 1000)} against ${o.write.targetMinutes} min${o.write.self ? `, and ${selfText[o.write.self]}` : ''}.`
          : null,
      ].filter((x): x is string => !!x);
      return view([
        {
          type: 'callout',
          tone: 'success',
          title: o.stopped ? 'Stopped for today' : 'Done',
          text: o.stopped
            ? "You stopped early, and that's fine. The cards you rated are saved."
            : `That's today's cards for "${p.chapter.title}".`,
        },
        { type: 'list', items: lines },
      ]);
    }
    case 'safety':
      return view(handoffBlocks(s.handoff ?? 'none'));
  }
}
