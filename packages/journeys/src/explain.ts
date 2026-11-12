import {
  edges,
  MASTERY_LABELS,
  type AssetSource,
  type Checkpoint,
  type Graph,
  type JourneyView,
  type MasteryLevel,
  type ViewAction,
  type ViewBlock,
  type ViewCitation,
  type ViewForm,
} from '@aicoach/core';
import { handoffBlocks, plural, reduceScopeView, type Notified } from './copy';

/**
 * Explanation journey (architecture §3.7, §7 Phase 4), one topic per session:
 *   why it matters → the short answer (answer first) → deeper layers on request → a check question
 *   with a hint ladder → teach it back / make your own card → close.
 * At the answer, depth and feedback steps the learner can ask or DISAGREE (challenge mode) and see
 * the worked answer. "Too much" offers a smaller plan from any working step; distress ends the
 * session at the fixed handoff step.
 */

export type ExplainNode =
  | 'brief'
  | 'answer'
  | 'depth'
  | 'check'
  | 'feedback'
  | 'teach_back'
  | 'make_card'
  | 'reduce_scope'
  | 'micro_win'
  | 'safety';

export type Verdict = 'correct' | 'partial' | 'incorrect';

/** What the session copies from the approved material when it starts (decision 9.6-4). */
export interface ExplainPlan {
  subject: string;
  chapter: { no: number; title: string; marks: number };
  topic: string;
  /** Marks levels the topic is asked at, and in how many of the analysed board papers. */
  asked: { marks: number[]; examPapers: number; papers: number };
  why: { exam: string; realWorld: string };
  summary: string;
  layers: { heading: string; body: string }[];
  keyTerms: string[];
  /** The worked exam answer of the topic's biggest note ("show working"). */
  working: {
    marks: number;
    question: string;
    answer: string;
    marksSplit: string | null;
    minutes: number | null;
    /** Its own [S#] numbering (it comes from another note than the summary). */
    sources: AssetSource[];
  } | null;
  check: {
    question: string;
    marks: number;
    /** MCQ: the options and which one is right (marked by code). */
    options: string[] | null;
    correctOption: number | null;
    answer: string;
    markingPoints: { point: string; marks: number }[];
    sources: AssetSource[];
  };
  /** [S#] in the summary and layers → book page. */
  sources: AssetSource[];
  prerequisites: string[];
  interests: string[];
}

export interface ChatTurn {
  kind: 'ask' | 'challenge';
  at: ExplainNode;
  question: string;
  reply: string;
  citations: ViewCitation[];
  notInBook: boolean;
  uncertain: boolean;
  /** Sums in the reply that don't work out (calculator check). */
  wrongSums: string[];
}

export interface TeachBack {
  text: string;
  covered: string[];
  missing: string[];
  feedback: string;
  /** Most of the key points were there. */
  good: boolean;
}

export interface ExplainState {
  plan: ExplainPlan;
  reduced: boolean;
  returnTo: ExplainNode | null;
  seenAnswer: boolean;
  depth: number;
  workingShown: boolean;
  chat: ChatTurn[];
  hints: string[];
  attempts: { text: string; verdict: Verdict; feedback: string }[];
  revealed: boolean;
  selfMark: 'got' | 'not_yet' | null;
  teachBack: TeachBack | null;
  card: { artefactId: string; front: string; back: string } | null;
  stopped: boolean;
  handoff: Notified | null;
}

export type ExplainEvent =
  | { type: 'start' }
  | { type: 'too_much' }
  | { type: 'go_deeper' }
  | { type: 'working_shown' }
  | { type: 'ready' }
  | { type: 'tutor_reply'; turn: ChatTurn }
  | { type: 'hint_given'; text: string }
  | { type: 'answered'; text: string; verdict: Verdict; feedback: string }
  | { type: 'reveal' }
  | { type: 'self_marked'; value: 'got' | 'not_yet' }
  | { type: 'teach_back' }
  | { type: 'taught'; result: TeachBack }
  | { type: 'make_card' }
  | { type: 'card_saved'; card: { artefactId: string; front: string; back: string } }
  | { type: 'finish' }
  | { type: 'continue_small' }
  | { type: 'continue_full' }
  | { type: 'stop_here' }
  | { type: 'distress'; notified: Notified };

/** Short units and bounded cost: limits on the open-ended parts. */
export const EXPLAIN_LIMITS = { chat: 6, hints: 2, attempts: 2 } as const;

export const explainStart = (plan: ExplainPlan): ExplainState => ({
  plan,
  reduced: false,
  returnTo: null,
  seenAnswer: false,
  depth: 0,
  workingShown: false,
  chat: [],
  hints: [],
  attempts: [],
  revealed: false,
  selfMark: null,
  teachBack: null,
  card: null,
  stopped: false,
  handoff: null,
});

const lastCorrect = (s: ExplainState) => s.attempts.at(-1)?.verdict === 'correct';
export const checkDone = (s: ExplainState) => lastCorrect(s) || s.revealed;
export const canChat = (s: ExplainState) => s.chat.length < EXPLAIN_LIMITS.chat;
export const canHint = (s: ExplainState) => s.hints.length < EXPLAIN_LIMITS.hints;

const e = edges<ExplainState, ExplainEvent, ExplainNode>();
/** Steps the learner can say "too much" at, and come back to. */
const PAUSABLE = ['brief', 'answer', 'depth', 'check', 'teach_back'] as const;
const TALK = ['answer', 'depth', 'feedback'] as const;

export const explainGraph: Graph<ExplainState, ExplainEvent, ExplainNode> = {
  id: 'explain',
  version: 1,
  start: 'brief',
  nodes: {
    brief: {},
    answer: {},
    depth: {},
    check: {},
    feedback: {},
    teach_back: {},
    make_card: {},
    reduce_scope: {},
    micro_win: { terminal: true },
    safety: { terminal: true },
  },
  edges: [
    e({
      id: 'brief.start',
      from: 'brief',
      on: 'start',
      to: 'answer',
      apply: (s) => ({ ...s, seenAnswer: true }),
    }),

    // Answer first; depth is one tap away and never forced.
    e({
      id: 'answer.deeper',
      from: 'answer',
      on: 'go_deeper',
      to: 'depth',
      guard: (s) => s.plan.layers.length > 0 && !s.reduced,
      apply: (s) => ({ ...s, depth: 1 }),
    }),
    e({
      id: 'depth.deeper',
      from: 'depth',
      on: 'go_deeper',
      to: 'depth',
      guard: (s) => s.depth < s.plan.layers.length,
      apply: (s) => ({ ...s, depth: s.depth + 1 }),
    }),
    ...(['answer', 'depth'] as const).map((n) =>
      e({
        id: `${n}.working`,
        from: n,
        on: 'working_shown',
        to: n,
        guard: (s) => !!s.plan.working && !s.workingShown,
        apply: (s) => ({ ...s, workingShown: true }),
      }),
    ),
    ...(['answer', 'depth'] as const).map((n) =>
      e({ id: `${n}.ready`, from: n, on: 'ready', to: 'check' }),
    ),
    // Ask or disagree: the reply (already produced) is added to the step's conversation.
    ...TALK.map((n) =>
      e({
        id: `${n}.reply`,
        from: n,
        on: 'tutor_reply',
        to: n,
        guard: canChat,
        apply: (s, ev) => ({ ...s, chat: [...s.chat, ev.turn] }),
      }),
    ),

    // Check question: two tries, a hint ladder, and the answer as the last rung.
    e({
      id: 'check.hint',
      from: 'check',
      on: 'hint_given',
      to: 'check',
      guard: canHint,
      apply: (s, ev) => ({ ...s, hints: [...s.hints, ev.text] }),
    }),
    e({
      id: 'check.answered.correct',
      from: 'check',
      on: 'answered',
      to: 'feedback',
      guard: (_s, ev) => ev.verdict === 'correct',
      apply: (s, ev) => ({ ...s, attempts: [...s.attempts, attempt(ev)] }),
    }),
    e({
      id: 'check.answered.retry',
      from: 'check',
      on: 'answered',
      to: 'check',
      guard: (s) => s.attempts.length + 1 < EXPLAIN_LIMITS.attempts,
      apply: (s, ev) => ({ ...s, attempts: [...s.attempts, attempt(ev)] }),
    }),
    e({
      id: 'check.answered.shown',
      from: 'check',
      on: 'answered',
      to: 'feedback',
      apply: (s, ev) => ({ ...s, attempts: [...s.attempts, attempt(ev)], revealed: true }),
    }),
    e({
      id: 'check.reveal',
      from: 'check',
      on: 'reveal',
      to: 'feedback',
      apply: (s) => ({ ...s, revealed: true }),
    }),

    // After the check: mark yourself, then make it yours (both optional).
    e({
      id: 'feedback.self_marked',
      from: 'feedback',
      on: 'self_marked',
      to: 'feedback',
      guard: (s) => !lastCorrect(s) && s.selfMark === null,
      apply: (s, ev) => ({ ...s, selfMark: ev.value }),
    }),
    e({
      id: 'feedback.teach',
      from: 'feedback',
      on: 'teach_back',
      to: 'teach_back',
      guard: (s) => !s.reduced && !s.teachBack,
    }),
    e({
      id: 'teach.taught',
      from: 'teach_back',
      on: 'taught',
      to: 'teach_back',
      guard: (s) => !s.teachBack,
      apply: (s, ev) => ({ ...s, teachBack: ev.result }),
    }),
    ...(['feedback', 'teach_back'] as const).map((n) =>
      e({
        id: `${n}.card`,
        from: n,
        on: 'make_card',
        to: 'make_card',
        guard: (s) => !s.reduced && !s.card,
      }),
    ),
    e({
      id: 'card.saved',
      from: 'make_card',
      on: 'card_saved',
      to: 'micro_win',
      apply: (s, ev) => ({ ...s, card: ev.card }),
    }),
    ...(['feedback', 'teach_back', 'make_card'] as const).map((n) =>
      e({ id: `${n}.finish`, from: n, on: 'finish', to: 'micro_win' }),
    ),

    // "Too much": a smaller plan, the same plan, or stop. Never a pep talk.
    ...PAUSABLE.map((n) =>
      e({
        id: `${n}.too_much`,
        from: n,
        on: 'too_much',
        to: 'reduce_scope',
        apply: (s) => ({ ...s, returnTo: n }),
      }),
    ),
    e({
      id: 'reduce.small.answer',
      from: 'reduce_scope',
      on: 'continue_small',
      to: 'answer',
      guard: (s) => !s.seenAnswer,
      apply: (s) => ({ ...s, reduced: true, seenAnswer: true, returnTo: null }),
    }),
    e({
      id: 'reduce.small.check',
      from: 'reduce_scope',
      on: 'continue_small',
      to: 'check',
      guard: (s) => !checkDone(s),
      apply: (s) => ({ ...s, reduced: true, returnTo: null }),
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
        apply: (s) => ({ ...s, returnTo: null, seenAnswer: s.seenAnswer || n !== 'brief' }),
      }),
    ),
    e({
      id: 'reduce.stop',
      from: 'reduce_scope',
      on: 'stop_here',
      to: 'micro_win',
      apply: (s) => ({ ...s, stopped: true, returnTo: null }),
    }),

    // Distress: from anywhere, straight to the fixed handoff step.
    e({
      id: 'any.distress',
      from: '*',
      on: 'distress',
      to: 'safety',
      apply: (s, ev) => ({ ...s, handoff: ev.notified }),
    }),
  ],
};

function attempt(ev: Extract<ExplainEvent, { type: 'answered' }>) {
  return { text: ev.text, verdict: ev.verdict, feedback: ev.feedback };
}

// ---------------------------------------------------------------- outcome (honest progress)

export type CheckResult =
  'first_try' | 'second_try' | 'with_hints' | 'self_got' | 'not_yet' | 'not_reached';

export interface ExplainOutcome {
  level: MasteryLevel;
  check: CheckResult;
  hints: number;
  attempts: number;
  layersRead: number;
  questionsAsked: number;
  teachBack: { covered: number; of: number; good: boolean } | null;
  card: boolean;
  stopped: boolean;
}

/** What happened, and the mastery level it earns (decision 9.6-9). No rounding up. */
export function explainOutcome(s: ExplainState): ExplainOutcome {
  const check: CheckResult = lastCorrect(s)
    ? s.hints.length > 0
      ? 'with_hints'
      : s.attempts.length === 1
        ? 'first_try'
        : 'second_try'
    : s.selfMark === 'got'
      ? 'self_got'
      : s.attempts.length || s.revealed
        ? 'not_yet'
        : 'not_reached';
  const base = !s.seenAnswer
    ? 0
    : check === 'first_try'
      ? 3
      : check === 'not_yet' || check === 'not_reached'
        ? 1
        : 2;
  const level = (base >= 2 && s.teachBack?.good ? base + 1 : base) as MasteryLevel;
  return {
    level,
    check,
    hints: s.hints.length,
    attempts: s.attempts.length,
    layersRead: s.depth,
    questionsAsked: s.chat.length,
    teachBack: s.teachBack
      ? {
          covered: s.teachBack.covered.length,
          of: s.teachBack.covered.length + s.teachBack.missing.length,
          good: s.teachBack.good,
        }
      : null,
    card: !!s.card,
    stopped: s.stopped,
  };
}

// ---------------------------------------------------------------- view

const STEPS = ['Why it matters', 'The answer', 'Check yourself', 'Make it yours', 'Done'] as const;
const STEP_OF: Record<ExplainNode, number> = {
  brief: 1,
  answer: 2,
  depth: 2,
  check: 3,
  feedback: 4,
  teach_back: 4,
  make_card: 4,
  reduce_scope: 0,
  micro_win: 5,
  safety: 5,
};

const TOO_MUCH: ViewAction = { id: 'too_much', label: 'This is too much today', style: 'link' };
const optionLabel = (o: string, i: number) =>
  `(${String.fromCharCode(97 + i)}) ${o.replace(/^\(?[a-dA-D][).]\s*/, '')}`;

function chatBlocks(s: ExplainState, ...at: ExplainNode[]): ViewBlock[] {
  return s.chat
    .filter((t) => at.includes(t.at))
    .flatMap((t): ViewBlock[] => [
      { type: 'chat', role: 'you', text: t.question },
      {
        type: 'chat',
        role: 'coach',
        text: t.reply,
        citations: t.citations,
        flags: [
          ...(t.notInBook ? ['Not in your textbook'] : []),
          ...(t.uncertain && !t.notInBook
            ? ["Check with your textbook: some points aren't clearly backed by it"]
            : []),
          ...t.wrongSums.map((w) => `Check this sum: ${w}`),
        ],
      },
    ]);
}

function talkForm(s: ExplainState): ViewForm[] {
  if (!canChat(s)) return [];
  return [
    {
      id: 'talk',
      title: 'Ask, or say what you think is wrong',
      fields: [
        {
          name: 'text',
          label: 'Your question or objection',
          placeholder: 'e.g. Why not the old ratio?',
          multiline: true,
        },
      ],
      submits: [
        { action: 'ask', label: 'Ask', style: 'primary' },
        { action: 'challenge', label: 'I disagree', style: 'secondary' },
      ],
    },
  ];
}

function answerBlocks(s: ExplainState, node: 'answer' | 'depth'): ViewBlock[] {
  const p = s.plan;
  const blocks: ViewBlock[] = [
    { type: 'heading', text: 'The short answer' },
    { type: 'markdown', text: p.summary, sources: p.sources },
  ];
  if (node === 'depth')
    for (const l of p.layers.slice(0, s.depth)) {
      blocks.push({ type: 'heading', text: l.heading });
      blocks.push({ type: 'markdown', text: l.body, sources: p.sources });
    }
  if (s.workingShown && p.working) {
    blocks.push({
      type: 'heading',
      text: `Worked answer · ${plural(p.working.marks, 'mark')}${p.working.marksSplit ? ` (${p.working.marksSplit})` : ''}`,
    });
    blocks.push({
      type: 'markdown',
      text: `**${p.working.question}**`,
      sources: p.working.sources,
    });
    blocks.push({ type: 'markdown', text: p.working.answer, sources: p.working.sources });
  }
  // The short answer and its deeper layers are one step: its conversation stays on screen.
  return [...blocks, ...chatBlocks(s, 'answer', 'depth')];
}

function outcomeLines(o: ExplainOutcome): string[] {
  const check: Record<CheckResult, string | null> = {
    first_try: 'Check question: right on the first try.',
    second_try: 'Check question: right on the second try.',
    with_hints: `Check question: right, with ${plural(o.hints, 'hint')}.`,
    self_got: 'Check question: you saw the answer and marked it "got it now".',
    not_yet: "Check question: not there yet. That's what the next session is for.",
    not_reached: null,
  };
  return [
    o.layersRead
      ? `You read the short answer and ${plural(o.layersRead, 'deeper part')}.`
      : 'You read the short answer.',
    o.questionsAsked ? `You asked or challenged ${plural(o.questionsAsked, 'time')}.` : null,
    check[o.check],
    o.teachBack
      ? `You explained it in your own words: ${o.teachBack.covered} of ${o.teachBack.of} key points.`
      : null,
    o.card ? 'You made your own card. It will come up in your memorise sessions.' : null,
  ].filter((x): x is string => !!x);
}

export function explainView(cp: Checkpoint<ExplainState, ExplainNode>): JourneyView {
  const s = cp.state;
  const p = s.plan;
  const node = cp.node;
  const stepNode = node === 'reduce_scope' ? (s.returnTo ?? 'brief') : node;
  const base = {
    title: p.topic,
    subtitle: `Chapter ${p.chapter.no} · ${p.chapter.title}`,
    progress: {
      step: STEP_OF[stepNode],
      of: STEPS.length,
      label: STEPS[STEP_OF[stepNode] - 1] ?? '',
    },
  };
  const view = (blocks: ViewBlock[], actions: ViewAction[] = [], forms: ViewForm[] = []) => ({
    ...base,
    blocks,
    actions,
    forms,
  });

  switch (node) {
    case 'brief': {
      const badges = [
        ...(p.asked.marks.length
          ? [{ label: `Asked for ${p.asked.marks.join(', ')} marks`, strong: true }]
          : []),
        ...(p.asked.papers
          ? [{ label: `In ${p.asked.examPapers} of ${p.asked.papers} board papers` }]
          : []),
        { label: `Chapter: ${p.chapter.marks} marks` },
      ];
      return view(
        [
          { type: 'badges', items: badges },
          { type: 'callout', tone: 'info', title: 'In the exam', text: p.why.exam },
          { type: 'callout', tone: 'info', title: 'In real life', text: p.why.realWorld },
          ...(p.prerequisites.length
            ? [
                {
                  type: 'text',
                  text: `It helps to know first: ${p.prerequisites.join(', ')}.`,
                  muted: true,
                } as const,
              ]
            : []),
          {
            type: 'text',
            text: 'About 8 minutes. You can stop at any step and pick it up later.',
            muted: true,
          },
        ],
        [
          { id: 'start', label: 'Start', style: 'primary' },
          { id: 'too_much', label: 'Not up to this today', style: 'link' },
        ],
      );
    }
    case 'answer':
    case 'depth': {
      const more = node === 'answer' ? p.layers.length : p.layers.length - s.depth;
      const actions: ViewAction[] = [{ id: 'ready', label: 'Got it. Check me', style: 'primary' }];
      if (more > 0 && !(node === 'answer' && s.reduced))
        actions.push({
          id: 'deeper',
          label: node === 'answer' ? 'Go deeper' : `Go deeper (${more} more)`,
          style: 'secondary',
        });
      if (p.working && !s.workingShown)
        actions.push({ id: 'working', label: 'Show the working', style: 'secondary' });
      actions.push(TOO_MUCH);
      return view(answerBlocks(s, node), actions, talkForm(s));
    }
    case 'check': {
      const c = p.check;
      const mcq = c.options && c.correctOption !== null ? c.options : null;
      const blocks: ViewBlock[] = [
        { type: 'badges', items: [{ label: plural(c.marks, 'mark'), strong: true }] },
        { type: 'markdown', text: c.question },
      ];
      for (const a of s.attempts) {
        blocks.push({ type: 'chat', role: 'you', text: a.text });
        blocks.push({ type: 'chat', role: 'coach', text: a.feedback });
      }
      s.hints.forEach((h, i) =>
        blocks.push({ type: 'callout', tone: 'info', title: `Hint ${i + 1}`, text: h }),
      );
      if (s.attempts.length)
        blocks.push({
          type: 'text',
          text: 'Have another go. Trying again costs nothing.',
          muted: true,
        });
      const actions: ViewAction[] = [
        ...(mcq ?? []).map((o, i): ViewAction => ({
          id: 'answer',
          label: optionLabel(o, i),
          style: 'secondary',
          value: i,
        })),
        ...(canHint(s)
          ? [{ id: 'hint', label: 'Give me a hint', style: 'secondary' } as const]
          : []),
        { id: 'reveal', label: 'Show me the answer', style: 'link' },
        TOO_MUCH,
      ];
      const forms: ViewForm[] = mcq
        ? []
        : [
            {
              id: 'answer',
              fields: [
                {
                  name: 'text',
                  label: 'Your answer',
                  placeholder: 'Write it the way you would in the exam',
                  multiline: true,
                },
              ],
              submits: [{ action: 'answer', label: 'Check my answer', style: 'primary' }],
            },
          ];
      return view(blocks, actions, forms);
    }
    case 'feedback': {
      const c = p.check;
      const right = lastCorrect(s);
      const last = s.attempts.at(-1);
      const blocks: ViewBlock[] = [];
      if (last) blocks.push({ type: 'chat', role: 'you', text: last.text });
      blocks.push(
        right
          ? { type: 'callout', tone: 'success', title: "That's right", text: last!.feedback }
          : {
              type: 'callout',
              tone: 'info',
              title: 'Here is the full answer',
              text: last?.feedback ?? 'Read it, then compare it with what you had in mind.',
            },
      );
      blocks.push({ type: 'markdown', text: c.answer, sources: c.sources });
      if (c.markingPoints.length) {
        blocks.push({ type: 'text', text: 'Marks are given for:' });
        blocks.push({
          type: 'list',
          items: c.markingPoints.map((m) => `${m.point} (${m.marks})`),
        });
      }
      blocks.push(...chatBlocks(s, 'feedback'));
      // Seeing the answer isn't knowing it: the learner says where they are.
      if (!right && s.selfMark === null)
        return view(
          blocks,
          [
            { id: 'self_mark', label: "I've got it now", style: 'primary', value: 'got' },
            { id: 'self_mark', label: 'Not yet', style: 'secondary', value: 'not_yet' },
          ],
          talkForm(s),
        );
      const actions: ViewAction[] = [];
      if (!s.reduced && !s.teachBack)
        actions.push({ id: 'teach', label: 'Explain it in my own words', style: 'secondary' });
      if (!s.reduced && !s.card)
        actions.push({ id: 'card', label: 'Make my own card', style: 'secondary' });
      actions.push({ id: 'finish', label: 'Finish', style: 'primary' });
      return view(blocks, actions, talkForm(s));
    }
    case 'teach_back': {
      const t = s.teachBack;
      if (!t)
        return view(
          [
            { type: 'heading', text: 'Teach it back' },
            {
              type: 'text',
              text: `Explain "${p.topic}" as if to a friend who missed the class. Two or three sentences are enough.`,
            },
          ],
          [{ id: 'finish', label: 'Skip and finish', style: 'link' }, TOO_MUCH],
          [
            {
              id: 'explain',
              fields: [{ name: 'text', label: 'In your own words', multiline: true }],
              submits: [{ action: 'explain', label: 'Send', style: 'primary' }],
            },
          ],
        );
      const blocks: ViewBlock[] = [
        { type: 'chat', role: 'you', text: t.text },
        { type: 'callout', tone: t.good ? 'success' : 'info', text: t.feedback },
      ];
      if (t.covered.length)
        blocks.push({ type: 'text', text: 'You covered:' }, { type: 'list', items: t.covered });
      if (t.missing.length)
        blocks.push({ type: 'text', text: 'Worth adding:' }, { type: 'list', items: t.missing });
      const actions: ViewAction[] = [];
      if (!s.reduced && !s.card)
        actions.push({ id: 'card', label: 'Make my own card', style: 'secondary' });
      actions.push({ id: 'finish', label: 'Finish', style: 'primary' });
      return view(blocks, actions);
    }
    case 'make_card':
      return view(
        [
          { type: 'heading', text: 'Make your own card' },
          {
            type: 'text',
            text: 'Write it your way. Your cards come up in your memorise sessions and stay in your locker.',
          },
        ],
        [{ id: 'finish', label: 'Skip and finish', style: 'link' }],
        [
          {
            id: 'card',
            fields: [
              { name: 'front', label: 'Front (the question)', value: `What is ${p.topic}?` },
              { name: 'back', label: 'Back (your answer)', multiline: true },
            ],
            submits: [{ action: 'save_card', label: 'Save my card', style: 'primary' }],
          },
        ],
      );
    case 'reduce_scope':
      return reduceScopeView(
        base,
        !s.seenAnswer
          ? 'Just the short answer and one question'
          : !checkDone(s)
            ? 'Just one question, then done'
            : 'Finish now',
      );
    case 'micro_win': {
      const o = explainOutcome(s);
      return view([
        {
          type: 'callout',
          tone: 'success',
          title: o.stopped ? 'Stopped for today' : 'Done',
          text: o.stopped
            ? "You stopped early, and that's fine. What you did is saved."
            : `That's "${p.topic}" for today.`,
        },
        { type: 'list', items: outcomeLines(o) },
        ...(o.level > 0
          ? [
              {
                type: 'text',
                text: `Where you are on this topic: ${MASTERY_LABELS[o.level]}.`,
              } as const,
            ]
          : []),
      ]);
    }
    case 'safety':
      return view(handoffBlocks(s.handoff ?? 'none'));
  }
}
