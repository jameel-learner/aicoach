import type { JourneyView, ViewBlock } from '@aicoach/core';

/**
 * Fixed wording shared by every journey. The distress response is deliberately NOT written by a
 * model (CLAUDE.md safety invariant, architecture §6.2): the same caring text every time, with the
 * helpline. It needs a counsellor's review before the pilot.
 */

export type Notified = 'parent' | 'poc' | 'none';

export const HANDOFF = {
  title: "Let's pause the studying",
  text: "It sounds like things are really heavy right now, and that matters more than this chapter. You don't have to carry it alone. Please talk to someone you trust today: a parent, a teacher, a friend.",
  helplines: [
    'Tele-MANAS: call 14416. Free, any time of day or night, in your language.',
    'If you are in danger right now, call 112.',
  ],
  told: {
    parent:
      "As we said when you signed up, we've let your parent or guardian know that you may need some support. We did not share what you wrote.",
    poc: "As we said when you signed up, we've let your institution's coordinator know that you may need some support. We did not share what you wrote.",
    none: '',
  } satisfies Record<Notified, string>,
} as const;

export function handoffBlocks(notified: Notified): ViewBlock[] {
  return [
    { type: 'callout', tone: 'safety', title: HANDOFF.title, text: HANDOFF.text },
    { type: 'list', items: [...HANDOFF.helplines] },
    ...(HANDOFF.told[notified]
      ? [{ type: 'text', text: HANDOFF.told[notified], muted: true } as const]
      : []),
    {
      type: 'text',
      text: 'Your work so far is saved. Come back to it whenever you want to.',
      muted: true,
    },
  ];
}

/** The "this is too much" step: a smaller plan is offered, never a pep talk (spec 5.5.7). */
export function reduceScopeView(
  base: Pick<JourneyView, 'title' | 'subtitle' | 'progress'>,
  small: string,
): JourneyView {
  return {
    ...base,
    blocks: [
      {
        type: 'callout',
        tone: 'info',
        title: "Let's make today smaller",
        text: "That's fine. Pick what fits right now. Whatever you choose, what you've done is saved.",
      },
    ],
    actions: [
      { id: 'small', label: small, style: 'primary' },
      { id: 'full', label: 'Carry on as planned', style: 'secondary' },
      { id: 'stop', label: 'Stop here for today', style: 'link' },
    ],
    forms: [],
  };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
