import { checkArithmetic, describeWrongSums } from '@aicoach/core';
import type { Db } from '@aicoach/db';
import type { ChatTurn, ExplainNode, ExplainPlan, TeachBack, Verdict } from '@aicoach/journeys';
import { z } from 'zod';
import { verifyCitations, withheldMarker } from '../content/answer';
import { retrieve } from '../content/retrieve';
import type { AskScope } from '../content/scope';
import { InsufficientCredits } from '../credits/ledger';
import type { Env, SessionUser } from '../env';
import { askJson } from '../llm/json';
import {
  MNEMONIC_IDEAS,
  NOT_IN_TEXTBOOK,
  SAFETY_MARKER,
  SESSION_CHECK,
  SESSION_HINT,
  SESSION_TEACH,
  SESSION_TUTOR,
} from '../llm/prompts';
import { runMeteredChat } from '../llm/run';

/**
 * The model calls of a study session (architecture §3.8: "agentic within a node"). Each returns a
 * RESULT that the SessionAgent feeds into the journey graph as an event; none of them decides where
 * the learner goes next. All go through the metered path, task `tutor_chat`.
 */

/**
 * The model flagged the learner's text as distress (third safety net, decision 9.6-5). Its reply is
 * discarded; the SessionAgent hands off. The call was made, so its charge is carried along.
 */
export class DistressSignal extends Error {
  constructor(readonly billedMicro: number) {
    super('The tutor model flagged distress');
  }
}
const flagged = z.object({ distress: z.literal(true) });
type Flagged = z.infer<typeof flagged>;
const isFlag = (v: unknown): v is Flagged =>
  !!v && typeof v === 'object' && (v as { distress?: unknown }).distress === true;

export interface Tutor {
  env: Env;
  db: Db;
  me: SessionUser;
  scope: AskScope;
}

const short = (max: number) =>
  z
    .string()
    .trim()
    .transform((s) => s.slice(0, max));

/** A question or an objection: grounded in the textbook like Ask, with the session as context. */
export async function tutorReply(
  t: Tutor,
  plan: ExplainPlan,
  o: { kind: ChatTurn['kind']; at: ExplainNode; question: string; history: ChatTurn[] },
  onDelta: (text: string) => void,
): Promise<{ turn: ChatTurn; billedMicro: number }> {
  const sources = await retrieve(
    t.env,
    t.db,
    `${o.question} (${plan.topic})`,
    t.scope.books.map((b) => b.tag),
    { topK: 4 },
  );
  const base = { kind: o.kind, at: o.at, question: o.question };
  if (!sources.length)
    return {
      turn: {
        ...base,
        reply: "Your textbook doesn't seem to cover this.",
        citations: [],
        notInBook: true,
        uncertain: false,
        wrongSums: [],
      },
      billedMicro: 0,
    };
  const res = await runMeteredChat(t.env, t.db, {
    task: 'tutor_chat',
    payers: t.scope.payers,
    userId: t.me.id,
    maxTokens: 500,
    messages: [
      {
        role: 'system',
        content: SESSION_TUTOR.system({
          subject: plan.subject,
          chapter: plan.chapter.title,
          topic: plan.topic,
          kind: o.kind,
          interests: plan.interests,
        }),
      },
      {
        role: 'user',
        content: SESSION_TUTOR.user({
          summary: plan.summary,
          history: o.history.slice(-2).map((h) => ({ question: h.question, reply: h.reply })),
          question: o.question,
          sources,
        }),
      },
    ],
    onDelta: withheldMarker(onDelta, [SAFETY_MARKER]),
  });
  const raw = res.content.trim();
  if (raw.startsWith(SAFETY_MARKER)) throw new DistressSignal(res.billedMicro);
  const notInBook = raw.startsWith(NOT_IN_TEXTBOOK);
  const v = verifyCitations(notInBook ? raw.slice(NOT_IN_TEXTBOOK.length).trim() : raw, sources);
  return {
    turn: {
      ...base,
      reply: v.answer,
      citations: v.citations.map((c) => ({
        n: c.n,
        bookTitle: c.bookTitle,
        page: c.page,
        supported: c.supported,
      })),
      notInBook,
      uncertain:
        !notInBook &&
        (!v.citations.length || v.hadInvalid || v.citations.some((c) => !c.supported)),
      // Calculator check (decision 9.6-6): sums in the reply that don't work out are flagged.
      wrongSums: describeWrongSums(checkArithmetic(v.answer).wrong),
    },
    billedMicro: res.billedMicro,
  };
}

const checkSchema = z.object({
  verdict: z.enum(['correct', 'partial', 'incorrect']),
  feedback: short(400),
});

/** Marks the learner's answer to the check question. MCQs are marked by code, at no cost. */
export async function judgeAnswer(
  t: Tutor,
  plan: ExplainPlan,
  answer: { text: string } | { option: number },
): Promise<{ text: string; verdict: Verdict; feedback: string; billedMicro: number }> {
  const c = plan.check;
  if ('option' in answer) {
    const right = answer.option === c.correctOption;
    return {
      text: c.options?.[answer.option] ?? '',
      verdict: right ? 'correct' : 'incorrect',
      feedback: right ? 'Yes, that is the one.' : 'Not that one. Look at the options again.',
      billedMicro: 0,
    };
  }
  const r = await askJson(t.env, t.db, {
    task: 'tutor_chat',
    payers: t.scope.payers,
    userId: t.me.id,
    schema: z.union([flagged, checkSchema]),
    system: SESSION_CHECK.system(plan.subject),
    user: SESSION_CHECK.user({
      question: c.question,
      answer: c.answer,
      markingPoints: c.markingPoints,
      studentAnswer: answer.text,
    }),
    maxTokens: 250,
  });
  if (isFlag(r.value)) throw new DistressSignal(r.billedMicro);
  return { text: answer.text, ...r.value, billedMicro: r.billedMicro };
}

/** A hint without a model: used when there are no credits or the model call fails. */
export function storedHint(plan: ExplainPlan, level: number): string {
  const c = plan.check;
  if (level <= 1) {
    if (plan.keyTerms.length) return `Think about: ${plan.keyTerms.slice(0, 3).join(', ')}.`;
    return c.markingPoints.length > 1
      ? `The examiner looks for ${c.markingPoints.length} points here.`
      : 'Go back to the short answer: the idea is in its first sentence.';
  }
  const words = c.answer
    .replace(/\[S\d+\]|[*_#|`]/g, ' ')
    .trim()
    .split(/\s+/);
  return `The answer starts: "${words.slice(0, Math.min(4, Math.max(1, words.length - 2))).join(' ')} …"`;
}

/** Hint ladder, rungs 1 and 2. Never fails: falls back to a stored hint (free). */
export async function giveHint(
  t: Tutor,
  plan: ExplainPlan,
  o: { level: number; hints: string[]; tries: string[] },
): Promise<{ text: string; billedMicro: number }> {
  try {
    const res = await runMeteredChat(t.env, t.db, {
      task: 'tutor_chat',
      payers: t.scope.payers,
      userId: t.me.id,
      maxTokens: 120,
      thinking: 'off',
      messages: [
        { role: 'system', content: SESSION_HINT.system },
        {
          role: 'user',
          content: SESSION_HINT.user({
            question: plan.check.question,
            answer: plan.check.answer,
            level: o.level,
            hints: o.hints,
            tries: o.tries,
          }),
        },
      ],
    });
    const text = res.content.trim().slice(0, 400);
    if (text.startsWith(SAFETY_MARKER)) throw new DistressSignal(res.billedMicro);
    if (text.length >= 8) return { text, billedMicro: res.billedMicro };
  } catch (err) {
    if (err instanceof DistressSignal) throw err;
    if (!(err instanceof InsufficientCredits)) console.warn('hint call failed; stored hint', err);
  }
  return { text: storedHint(plan, o.level), billedMicro: 0 };
}

const teachSchema = z.object({
  covered: z.array(short(120)).max(6).default([]),
  missing: z.array(short(160)).max(4).default([]),
  good: z.boolean(),
  feedback: short(400),
});

export async function judgeTeachBack(
  t: Tutor,
  plan: ExplainPlan,
  explanation: string,
): Promise<{ result: TeachBack; billedMicro: number }> {
  const r = await askJson(t.env, t.db, {
    task: 'tutor_chat',
    payers: t.scope.payers,
    userId: t.me.id,
    schema: z.union([flagged, teachSchema]),
    system: SESSION_TEACH.system(plan.subject),
    user: SESSION_TEACH.user({
      topic: plan.topic,
      summary: [plan.summary, ...plan.layers.map((l) => `${l.heading}: ${l.body}`)]
        .join('\n')
        .slice(0, 3000),
      keyTerms: plan.keyTerms,
      explanation,
    }),
    maxTokens: 350,
  });
  if (isFlag(r.value)) throw new DistressSignal(r.billedMicro);
  return { result: { text: explanation, ...r.value }, billedMicro: r.billedMicro };
}

const ideasSchema = z.object({ ideas: z.array(short(240)).min(1).max(4) });

export async function hookIdeas(
  t: Tutor,
  o: { front: string; back: string; seed: string; interests: string[] },
): Promise<{ ideas: string[]; billedMicro: number }> {
  const r = await askJson(t.env, t.db, {
    task: 'tutor_chat',
    payers: t.scope.payers,
    userId: t.me.id,
    schema: z.union([flagged, ideasSchema]),
    system: MNEMONIC_IDEAS.system(o.interests),
    user: MNEMONIC_IDEAS.user(o),
    maxTokens: 300,
  });
  if (isFlag(r.value)) throw new DistressSignal(r.billedMicro);
  return { ideas: r.value.ideas.filter(Boolean).slice(0, 3), billedMicro: r.billedMicro };
}
