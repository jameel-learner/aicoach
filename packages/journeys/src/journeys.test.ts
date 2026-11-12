import {
  InvalidTransition,
  startOf,
  step,
  transitionKey,
  transitions,
  validateGraph,
  type Checkpoint,
  type Graph,
  type JourneyEvent,
} from '@aicoach/core';
import { describe, expect, it } from 'vitest';
import {
  explainGraph,
  explainOutcome,
  explainStart,
  explainView,
  type ChatTurn,
  type ExplainEvent,
  type ExplainNode,
  type ExplainPlan,
  type ExplainState,
} from './explain';
import {
  isRepeat,
  memoriseGraph,
  memoriseOutcome,
  memoriseStart,
  memoriseView,
  type MemoriseEvent,
  type MemoriseNode,
  type MemorisePlan,
  type MemoriseState,
} from './memorise';

/**
 * Phase 4 exit criterion: 100% transition coverage on the journey graphs. Every (edge, from-node)
 * pair must be taken by some scenario below; the last test of each journey proves none is left.
 */
class Driver<S, E extends JourneyEvent, N extends string> {
  covered = new Set<string>();
  /** One checkpoint per node, to try things "from every step". */
  seen = new Map<N, Checkpoint<S, N>>();
  constructor(
    private graph: Graph<S, E, N>,
    private render: (cp: Checkpoint<S, N>) => { blocks: unknown[]; actions: unknown[] },
  ) {}
  note(cp: Checkpoint<S, N>) {
    if (!this.seen.has(cp.node)) this.seen.set(cp.node, cp);
    // Every step must be showable.
    const v = this.render(cp);
    expect(v.blocks.length + v.actions.length).toBeGreaterThan(0);
    return cp;
  }
  run(from: Checkpoint<S, N>, ...events: E[]) {
    let cp = this.note(from);
    for (const ev of events) {
      const r = step(this.graph, cp, ev);
      this.covered.add(transitionKey(r.edge, r.from));
      cp = this.note(r.checkpoint);
    }
    return cp;
  }
  missing() {
    return transitions(this.graph)
      .map((t) => t.key)
      .filter((k) => !this.covered.has(k));
  }
}

// ================================================================ explanation

const PLAN: ExplainPlan = {
  subject: 'KSEAB 2nd PUC Accountancy',
  chapter: { no: 3, title: 'Retirement of a partner', marks: 14 },
  topic: 'Gaining ratio',
  asked: { marks: [1, 6], examPapers: 4, papers: 8 },
  why: { exam: 'Asked almost every year.', realWorld: 'Firms use it when a partner leaves.' },
  summary: 'Gaining ratio = new ratio − old ratio [S1].',
  layers: [
    { heading: 'Meaning', body: 'The ratio in which continuing partners gain [S1].' },
    { heading: 'When it is used', body: 'On retirement or death of a partner [S2].' },
  ],
  keyTerms: ['gaining ratio', 'continuing partners'],
  working: {
    marks: 6,
    question: 'A, B and C share 3:2:1. C retires. Find the gaining ratio.',
    answer: 'A gains 3/5 − 3/6 = 1/10',
    marksSplit: '1+2+2+1=6',
    minutes: 13.5,
    sources: [],
  },
  check: {
    question: 'State the formula for gaining ratio.',
    marks: 1,
    options: null,
    correctOption: null,
    answer: 'Gaining ratio = New ratio − Old ratio',
    markingPoints: [{ point: 'Correct formula', marks: 1 }],
    sources: [],
  },
  sources: [{ n: 1, bookId: 'b', bookTitle: 'Part I', page: 120, section: null }],
  prerequisites: ['Profit sharing ratio'],
  interests: ['Cricket'],
};

const turn = (at: ExplainNode, kind: ChatTurn['kind'] = 'ask'): ChatTurn => ({
  kind,
  at,
  question: 'Why not the old ratio?',
  reply: 'Because the gain is the change [S1].',
  citations: [{ n: 1, bookTitle: 'Part I', page: 120, supported: true }],
  notInBook: false,
  uncertain: false,
  wrongSums: [],
});
const answered = (verdict: 'correct' | 'partial' | 'incorrect'): ExplainEvent => ({
  type: 'answered',
  text: 'my answer',
  verdict,
  feedback: verdict === 'correct' ? 'Yes.' : 'Not quite: think about what changes.',
});
const taught = (good: boolean): ExplainEvent => ({
  type: 'taught',
  result: {
    text: 'It is what the others gain',
    covered: ['gain of continuing partners'],
    missing: good ? [] : ['the formula'],
    feedback: 'Clear.',
    good,
  },
});

describe('explanation journey', () => {
  const d = new Driver<ExplainState, ExplainEvent, ExplainNode>(explainGraph, explainView);
  const begin = () => startOf(explainGraph, explainStart(PLAN));

  it('is structurally sound', () => {
    expect(validateGraph(explainGraph)).toEqual([]);
  });

  it('full path: depth, working, questions, hint, second try, teach-back, own card', () => {
    const end = d.run(
      begin(),
      { type: 'start' },
      { type: 'working_shown' },
      { type: 'tutor_reply', turn: turn('answer') },
      { type: 'go_deeper' },
      { type: 'go_deeper' },
      { type: 'tutor_reply', turn: turn('depth', 'challenge') },
      { type: 'ready' },
      { type: 'hint_given', text: 'Think about what changes for those who stay.' },
      answered('partial'),
      answered('correct'),
      { type: 'tutor_reply', turn: turn('feedback') },
      { type: 'teach_back' },
      taught(true),
      { type: 'make_card' },
      { type: 'card_saved', card: { artefactId: 'a1', front: 'Q', back: 'A' } },
    );
    expect(end.node).toBe('micro_win');
    expect(end.seq).toBe(15);
    // Right with a hint = "got it with help" (2); a good teach-back lifts it one level.
    expect(explainOutcome(end.state)).toMatchObject({
      level: 3,
      check: 'with_hints',
      hints: 1,
      attempts: 2,
      layersRead: 2,
      questionsAsked: 3,
      card: true,
      stopped: false,
    });
    const text = JSON.stringify(explainView(end));
    expect(text).toContain('right, with 1 hint');
    expect(text).toContain('Got it');
    // Both layers were read, so a third "go deeper" is not possible.
    const deep = d.run(begin(), { type: 'start' }, { type: 'go_deeper' }, { type: 'go_deeper' });
    expect(() => step(explainGraph, deep, { type: 'go_deeper' })).toThrow(InvalidTransition);
    expect(explainView(deep).actions.map((a) => a.id)).not.toContain('deeper');
  });

  it('right on the first try is "got it"; the card is optional', () => {
    const end = d.run(
      begin(),
      { type: 'start' },
      { type: 'ready' },
      answered('correct'),
      { type: 'make_card' },
      { type: 'finish' },
    );
    expect(explainOutcome(end.state)).toMatchObject({ level: 3, check: 'first_try', card: false });
  });

  it('two wrong tries show the answer; the learner marks themself', () => {
    const shown = d.run(
      begin(),
      { type: 'start' },
      { type: 'go_deeper' },
      { type: 'working_shown' },
      { type: 'ready' },
      answered('incorrect'),
      answered('incorrect'),
    );
    expect(shown.node).toBe('feedback');
    expect(shown.state.revealed).toBe(true);
    // Until they say where they are, only the self-mark buttons are offered.
    expect(explainView(shown).actions.map((a) => a.id)).toEqual(['self_mark', 'self_mark']);
    const end = d.run(shown, { type: 'self_marked', value: 'got' }, { type: 'finish' });
    expect(explainOutcome(end.state)).toMatchObject({ level: 2, check: 'self_got' });
    expect(() => step(explainGraph, end, { type: 'finish' })).toThrow(InvalidTransition);
  });

  it('asking for the answer and saying "not yet" stays at "seen"', () => {
    const end = d.run(
      begin(),
      { type: 'start' },
      { type: 'ready' },
      { type: 'reveal' },
      { type: 'self_marked', value: 'not_yet' },
      { type: 'teach_back' },
      { type: 'finish' },
    );
    expect(explainOutcome(end.state)).toMatchObject({ level: 1, check: 'not_yet' });
    expect(JSON.stringify(explainView(end))).toContain('Seen');
  });

  it('limits hints and conversation turns', () => {
    let cp = d.run(begin(), { type: 'start' }, { type: 'ready' });
    cp = d.run(cp, { type: 'hint_given', text: 'h1' }, { type: 'hint_given', text: 'h2' });
    expect(() => step(explainGraph, cp, { type: 'hint_given', text: 'h3' })).toThrow();
    expect(explainView(cp).actions.map((a) => a.id)).not.toContain('hint');
    let chat = d.run(begin(), { type: 'start' });
    for (let i = 0; i < 6; i++) chat = d.run(chat, { type: 'tutor_reply', turn: turn('answer') });
    expect(() => step(explainGraph, chat, { type: 'tutor_reply', turn: turn('answer') })).toThrow();
    expect(explainView(chat).forms).toEqual([]);
  });

  it('"too much" offers a smaller plan, the same plan, or stopping', () => {
    // Before starting → smaller plan: the short answer and one question, nothing else.
    let cp = d.run(begin(), { type: 'too_much' });
    expect(explainView(cp).actions.map((a) => a.label)).toEqual([
      'Just the short answer and one question',
      'Carry on as planned',
      'Stop here for today',
    ]);
    cp = d.run(cp, { type: 'continue_small' });
    expect(cp.node).toBe('answer');
    expect(() => step(explainGraph, cp, { type: 'go_deeper' })).toThrow(InvalidTransition);
    cp = d.run(cp, { type: 'too_much' }, { type: 'continue_full' });
    expect(cp.node).toBe('answer');
    cp = d.run(cp, { type: 'ready' }, { type: 'too_much' }, { type: 'continue_small' });
    expect(cp.node).toBe('check');
    cp = d.run(cp, { type: 'too_much' }, { type: 'continue_full' }, { type: 'reveal' });
    // In the smaller plan there is no teach-back and no card.
    expect(() => step(explainGraph, cp, { type: 'teach_back' })).toThrow(InvalidTransition);
    expect(() => step(explainGraph, cp, { type: 'make_card' })).toThrow(InvalidTransition);
    expect(d.run(cp, { type: 'finish' }).node).toBe('micro_win');

    // Carry on as planned returns to the step the learner was at.
    let full = d.run(begin(), { type: 'too_much' }, { type: 'continue_full' });
    expect(full.node).toBe('brief');
    full = d.run(
      full,
      { type: 'start' },
      { type: 'go_deeper' },
      { type: 'too_much' },
      { type: 'continue_full' },
    );
    expect(full).toMatchObject({ node: 'depth', state: { depth: 1 } });
    full = d.run(
      full,
      { type: 'ready' },
      answered('correct'),
      { type: 'teach_back' },
      { type: 'too_much' },
      { type: 'continue_full' },
    );
    expect(full.node).toBe('teach_back');
    // After the check is done, the smaller plan is simply to finish.
    const done = d.run(full, { type: 'too_much' }, { type: 'continue_small' });
    expect(done.node).toBe('micro_win');

    const stopped = d.run(begin(), { type: 'start' }, { type: 'too_much' }, { type: 'stop_here' });
    expect(explainOutcome(stopped.state)).toMatchObject({ level: 1, stopped: true });
    expect(JSON.stringify(explainView(stopped))).toContain('Stopped for today');
  });

  it('distress ends the session at the fixed handoff step, from every step', () => {
    d.run(d.run(begin(), { type: 'start' }, { type: 'ready' }, { type: 'reveal' }), {
      type: 'make_card',
    });
    const nodes = Object.keys(explainGraph.nodes) as ExplainNode[];
    for (const n of nodes.filter((x) => !explainGraph.nodes[x].terminal)) {
      const cp = d.seen.get(n);
      expect(cp, `no scenario reached "${n}"`).toBeDefined();
      const end = d.run(cp!, { type: 'distress', notified: 'parent' });
      expect(end.node).toBe('safety');
      const v = explainView(end);
      expect(v.actions).toEqual([]);
      expect(v.forms).toEqual([]);
      expect(JSON.stringify(v)).toContain('14416');
      expect(JSON.stringify(v)).toContain('parent or guardian');
    }
  });

  it('covers every transition', () => {
    expect(d.missing()).toEqual([]);
  });
});

// ================================================================ memorisation

const card = (k: string, box = 0) => ({
  key: k,
  topic: 'Goodwill',
  front: `Front ${k}`,
  back: `Back ${k}`,
  own: k === 'c3',
  box,
  hook: null,
});
const MPLAN: MemorisePlan = {
  subject: 'KSEAB 2nd PUC Accountancy',
  chapter: { no: 2, title: 'Goodwill', marks: 8 },
  cards: [card('c1', 2), card('c2'), card('c3')],
  due: 1,
  fresh: 2,
  total: 12,
  writeOut: {
    topic: 'Goodwill',
    marks: 2,
    minutes: 4.5,
    question: 'State two factors affecting goodwill.',
    answer: '1. Location [S1]\n2. Efficiency of management [S1]',
    marksSplit: '1+1=2',
    sources: [],
  },
  interests: ['Music'],
};
const T0 = 1_800_000_000_000;
const rated = (rating: 'got' | 'almost' | 'forgot', at = T0): MemoriseEvent => ({
  type: 'rated',
  rating,
  at,
});

describe('memorisation journey', () => {
  const d = new Driver<MemoriseState, MemoriseEvent, MemoriseNode>(memoriseGraph, (cp) =>
    memoriseView(cp, T0 + 60_000),
  );
  const begin = (plan = MPLAN) => startOf(memoriseGraph, memoriseStart(plan));

  it('is structurally sound', () => {
    expect(validateGraph(memoriseGraph)).toEqual([]);
  });

  it('full path: a forgotten card returns once, a hook is made, then the timed write-out', () => {
    let cp = d.run(begin(), { type: 'start' }, { type: 'show' }, { type: 'make_hook' });
    cp = d.run(cp, { type: 'ideas', ideas: ['A', 'B'] }, { type: 'ideas', ideas: ['C'] });
    expect(() => step(memoriseGraph, cp, { type: 'ideas', ideas: ['D'] })).toThrow();
    cp = d.run(cp, { type: 'hook_saved', text: 'Good Will Hunting', artefactId: 'h1' });
    expect(JSON.stringify(memoriseView(cp, T0))).toContain('Good Will Hunting');
    cp = d.run(cp, rated('forgot'));
    expect(cp.state.queue).toEqual(['c1', 'c2', 'c3', 'c1']);
    cp = d.run(cp, { type: 'show' }, { type: 'make_hook' }, { type: 'back' }, rated('got'));
    cp = d.run(cp, { type: 'show' }, rated('almost'));
    // c1 again: it can't be queued a second time, and its "got it" is a repeat.
    expect(cp.node).toBe('recall');
    expect(isRepeat(cp.state)).toBe(true);
    cp = d.run(cp, { type: 'show' }, rated('forgot'));
    expect(cp.node).toBe('write_out');
    expect(cp.state.queue).toHaveLength(4);
    cp = d.run(cp, { type: 'begin_writing', at: T0 });
    expect(JSON.stringify(memoriseView(cp, T0 + 90_000))).toContain('"elapsedMs":90000');
    cp = d.run(cp, { type: 'done_writing', at: T0 + 5 * 60_000 });
    expect(JSON.stringify(memoriseView(cp, T0))).toContain('0:30 over');
    cp = d.run(cp, { type: 'self_checked', self: 'most' });
    expect(cp.node).toBe('micro_win');
    expect(memoriseOutcome(cp.state)).toEqual({
      cards: 3,
      got: 1,
      almost: 1,
      forgot: 1,
      hooks: 1,
      write: { seconds: 300, targetMinutes: 4.5, self: 'most' },
      stopped: false,
    });
    expect(JSON.stringify(memoriseView(cp, T0))).toContain('2 cards will come back tomorrow');
  });

  it('ends after the cards when the chapter has no write-out, or when it is skipped', () => {
    let cp = d.run(begin({ ...MPLAN, writeOut: null, cards: [card('c1')] }), { type: 'start' });
    cp = d.run(cp, { type: 'show' }, rated('got'));
    expect(cp.node).toBe('micro_win');
    let skip = d.run(begin({ ...MPLAN, cards: [card('c1')] }), { type: 'start' }, { type: 'show' });
    skip = d.run(skip, rated('got'), { type: 'skip_writing' });
    expect(skip.node).toBe('micro_win');
    expect(memoriseOutcome(skip.state).write).toBeNull();
  });

  it('"too much": three more cards without repeats or write-out, carry on, or stop', () => {
    const many: MemorisePlan = {
      ...MPLAN,
      cards: ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => card(k)),
    };
    let cp = d.run(begin(many), { type: 'start' }, { type: 'show' }, rated('got'));
    cp = d.run(cp, { type: 'too_much' });
    expect(memoriseView(cp, T0).actions[0]!.label).toBe('Just 3 more cards, then done');
    cp = d.run(cp, { type: 'continue_small' });
    expect(cp.state.queue).toEqual(['a', 'b', 'c', 'd']);
    cp = d.run(cp, { type: 'show' }, rated('forgot'), { type: 'show' }, rated('got'));
    cp = d.run(cp, { type: 'show' }, rated('got'));
    // Reduced: the forgotten card did not come back and there is no write-out.
    expect(cp.node).toBe('micro_win');

    // Carry on from every step it can be said at.
    let full = d.run(begin(), { type: 'too_much' }, { type: 'continue_full' });
    expect(full.node).toBe('brief');
    full = d.run(full, { type: 'start' }, { type: 'too_much' }, { type: 'continue_full' });
    expect(full.node).toBe('recall');
    full = d.run(full, { type: 'show' }, { type: 'too_much' }, { type: 'continue_full' });
    expect(full.node).toBe('reveal');
    full = d.run(full, { type: 'make_hook' }, { type: 'too_much' }, { type: 'continue_full' });
    expect(full).toMatchObject({ node: 'mnemonic', state: { hooking: { key: 'c1' } } });
    full = d.run(full, { type: 'back' }, rated('got'), { type: 'show' }, rated('got'));
    full = d.run(full, { type: 'show' }, rated('got'));
    full = d.run(full, { type: 'too_much' }, { type: 'continue_full' });
    expect(full.node).toBe('write_out');
    full = d.run(full, { type: 'begin_writing', at: T0 }, { type: 'too_much' });
    const back = d.run(full, { type: 'continue_full' });
    expect(back).toMatchObject({ node: 'writing', state: { write: { startedAt: T0 } } });
    // All cards done: the smaller plan is to finish.
    expect(d.run(full, { type: 'continue_small' }).node).toBe('micro_win');
    const stopped = d.run(full, { type: 'stop_here' });
    expect(memoriseOutcome(stopped.state)).toMatchObject({ cards: 3, stopped: true, write: null });
  });

  it('distress ends the session at the fixed handoff step, from every step', () => {
    let cp = d.run(begin({ ...MPLAN, cards: [card('c1')] }), { type: 'start' }, { type: 'show' });
    cp = d.run(cp, rated('got'), { type: 'begin_writing', at: T0 });
    d.run(cp, { type: 'done_writing', at: T0 + 1000 });
    const nodes = Object.keys(memoriseGraph.nodes) as MemoriseNode[];
    for (const n of nodes.filter((x) => !memoriseGraph.nodes[x].terminal)) {
      const at = d.seen.get(n);
      expect(at, `no scenario reached "${n}"`).toBeDefined();
      const end = d.run(at!, { type: 'distress', notified: 'none' });
      expect(end.node).toBe('safety');
      const text = JSON.stringify(memoriseView(end, T0));
      expect(text).toContain('14416');
      expect(text).not.toContain('parent or guardian');
    }
  });

  it('covers every transition', () => {
    expect(d.missing()).toEqual([]);
  });
});
