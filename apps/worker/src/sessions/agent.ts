import {
  InvalidTransition,
  isOpenSession,
  listens,
  RECALL_RATINGS,
  step,
  type Checkpoint,
  type Graph,
  type JourneyEvent,
  type JourneyId,
  type JourneyView,
  type RecallRating,
  type SessionAct,
  type SessionEvent,
  type SessionStatus,
  type SessionView,
} from '@aicoach/core';
import { createDb, type Db } from '@aicoach/db';
import {
  canAskIdeas,
  canChat,
  canHint,
  currentCard,
  explainGraph,
  explainOutcome,
  explainView,
  isRepeat,
  memoriseGraph,
  memoriseOutcome,
  memoriseView,
  type ExplainEvent,
  type ExplainNode,
  type ExplainState,
  type MemoriseEvent,
  type MemoriseNode,
  type MemoriseState,
  type WriteSelf,
} from '@aicoach/journeys';
import { DurableObject } from 'cloudflare:workers';
import { askScope } from '../content/scope';
import { InsufficientCredits } from '../credits/ledger';
import type { Env, SessionUser } from '../env';
import { createNotifier } from '../lib/notifier';
import { classify } from '../safety/classify';
import { handoff } from '../safety/handoff';
import {
  recordStep,
  saveArtefact,
  saveMastery,
  saveReview,
  setSessionStatus,
  type SessionRow,
} from './records';
import {
  DistressSignal,
  giveHint,
  hookIdeas,
  judgeAnswer,
  judgeTeachBack,
  tutorReply,
  type Tutor,
} from './tutor';

/**
 * SessionAgent (architecture §3.7, decisions 9.6-1…3): one Durable Object per study session.
 *
 *  - It holds the session's checkpoint and writes it after EVERY step; nothing lives only in
 *    memory, so the app can be killed at any point and the session resumes on any device.
 *  - A learner action arrives as one request. The agent does the I/O the step needs (safety check,
 *    model call, saving a card), then feeds the result into the journey graph as an event. Where the
 *    learner goes next is decided by the graph (pure code), never by the model.
 *  - A failed or refused step changes nothing: the checkpoint stays where it was.
 *  - Alarms: an idle session is marked paused; a session nobody returns to is cleaned up.
 */

export interface StoredSession extends SessionRow {
  cp: Checkpoint<unknown, string>;
  status: SessionStatus;
  billedMicro: number;
  startedAt: number;
  updatedAt: number;
}

const KEY = 's';
const IDLE_MS = 30 * 60_000;
const KEEP_OPEN_MS = 30 * 86_400_000;
const KEEP_DONE_MS = 7 * 86_400_000;

/** The learner asked for something that isn't possible now, or sent something unusable. */
class Refused extends Error {
  constructor(
    readonly code: 'not_available' | 'bad_request',
    message: string,
  ) {
    super(message);
  }
}
const notNow = () => new Refused('not_available', "That isn't available at this step.");

interface Run {
  env: Env;
  db: Db;
  me: SessionUser;
  s: StoredSession;
  input: SessionAct;
  now: number;
  delta: (text: string) => void;
  tutor: () => Promise<Tutor>;
}
type Resolved<E> = { event: E; billedMicro: number };
const free = <E>(event: E): Resolved<E> => ({ event, billedMicro: 0 });

const field = (r: Run, name: string, max: number) => {
  const v = (r.input.fields?.[name] ?? '').trim();
  if (!v) throw new Refused('bad_request', 'Write something first.');
  return v.slice(0, max);
};

// ---------------------------------------------------------------- explanation

async function resolveExplain(
  r: Run,
  cp: Checkpoint<ExplainState, ExplainNode>,
): Promise<Resolved<ExplainEvent>> {
  const s = cp.state;
  const plain: Record<string, ExplainEvent> = {
    start: { type: 'start' },
    too_much: { type: 'too_much' },
    deeper: { type: 'go_deeper' },
    working: { type: 'working_shown' },
    ready: { type: 'ready' },
    reveal: { type: 'reveal' },
    teach: { type: 'teach_back' },
    card: { type: 'make_card' },
    finish: { type: 'finish' },
    small: { type: 'continue_small' },
    full: { type: 'continue_full' },
    stop: { type: 'stop_here' },
  };
  const direct = plain[r.input.action];
  if (direct) return free(direct);

  switch (r.input.action) {
    case 'self_mark': {
      if (r.input.value !== 'got' && r.input.value !== 'not_yet') throw notNow();
      return free({ type: 'self_marked', value: r.input.value });
    }
    case 'ask':
    case 'challenge': {
      if (!listens(explainGraph, cp.node, 'tutor_reply') || !canChat(s)) throw notNow();
      const question = field(r, 'text', 1000);
      const out = await tutorReply(
        await r.tutor(),
        s.plan,
        { kind: r.input.action, at: cp.node, question, history: s.chat },
        r.delta,
      );
      return { event: { type: 'tutor_reply', turn: out.turn }, billedMicro: out.billedMicro };
    }
    case 'hint': {
      if (cp.node !== 'check' || !canHint(s)) throw notNow();
      const out = await giveHint(await r.tutor(), s.plan, {
        level: s.hints.length + 1,
        hints: s.hints,
        tries: s.attempts.map((a) => a.text),
      });
      return { event: { type: 'hint_given', text: out.text }, billedMicro: out.billedMicro };
    }
    case 'answer': {
      if (cp.node !== 'check') throw notNow();
      const c = s.plan.check;
      const mcq = !!c.options && c.correctOption !== null;
      if (mcq) {
        const i = Number(r.input.value);
        if (!Number.isInteger(i) || i < 0 || i >= c.options!.length) throw notNow();
      }
      const out = await judgeAnswer(
        await r.tutor(),
        s.plan,
        mcq ? { option: Number(r.input.value) } : { text: field(r, 'text', 2000) },
      );
      return {
        event: { type: 'answered', text: out.text, verdict: out.verdict, feedback: out.feedback },
        billedMicro: out.billedMicro,
      };
    }
    case 'explain': {
      if (cp.node !== 'teach_back' || s.teachBack) throw notNow();
      const out = await judgeTeachBack(await r.tutor(), s.plan, field(r, 'text', 2000));
      return { event: { type: 'taught', result: out.result }, billedMicro: out.billedMicro };
    }
    case 'save_card': {
      if (cp.node !== 'make_card') throw notNow();
      const card = { front: field(r, 'front', 300), back: field(r, 'back', 800) };
      const artefactId = await saveArtefact(r.db, {
        userId: r.me.id,
        offeringId: r.s.offeringId,
        kind: 'card',
        chapter: r.s.chapter,
        topic: s.plan.topic,
        content: card,
        sessionId: r.s.id,
      });
      return free({ type: 'card_saved', card: { artefactId, ...card } });
    }
    default:
      throw notNow();
  }
}

// ---------------------------------------------------------------- memorisation

async function resolveMemorise(
  r: Run,
  cp: Checkpoint<MemoriseState, MemoriseNode>,
): Promise<Resolved<MemoriseEvent>> {
  const s = cp.state;
  const plain: Record<string, MemoriseEvent> = {
    start: { type: 'start' },
    too_much: { type: 'too_much' },
    show: { type: 'show' },
    hook: { type: 'make_hook' },
    back: { type: 'back' },
    skip: { type: 'skip_writing' },
    write: { type: 'begin_writing', at: r.now },
    done_writing: { type: 'done_writing', at: r.now },
    small: { type: 'continue_small' },
    full: { type: 'continue_full' },
    stop: { type: 'stop_here' },
  };
  const direct = plain[r.input.action];
  if (direct) return free(direct);

  const saveHook = async (text: string): Promise<Resolved<MemoriseEvent>> => {
    const card = s.plan.cards.find((c) => c.key === s.hooking?.key);
    if (cp.node !== 'mnemonic' || !card) throw notNow();
    const artefactId = await saveArtefact(r.db, {
      userId: r.me.id,
      offeringId: r.s.offeringId,
      kind: 'mnemonic',
      chapter: r.s.chapter,
      topic: card.topic,
      cardKey: card.key,
      content: { text, for: card.front },
      sessionId: r.s.id,
    });
    return free({ type: 'hook_saved', text, artefactId });
  };

  switch (r.input.action) {
    case 'rate': {
      const rating = r.input.value as RecallRating;
      if (cp.node !== 'reveal' || !RECALL_RATINGS.includes(rating)) throw notNow();
      return free({ type: 'rated', rating, at: r.now });
    }
    case 'ideas': {
      const card = s.plan.cards.find((c) => c.key === s.hooking?.key);
      if (cp.node !== 'mnemonic' || !card || !canAskIdeas(s)) throw notNow();
      const out = await hookIdeas(await r.tutor(), {
        front: card.front,
        back: card.back,
        seed: (r.input.fields?.text ?? '').slice(0, 400),
        interests: s.plan.interests,
      });
      return { event: { type: 'ideas', ideas: out.ideas }, billedMicro: out.billedMicro };
    }
    case 'use_idea': {
      const idea = s.hooking?.ideas[Number(r.input.value)];
      if (!idea) throw notNow();
      return saveHook(idea);
    }
    case 'save_hook':
      return saveHook(field(r, 'text', 400));
    case 'self_check': {
      const self = r.input.value as WriteSelf;
      if (!['all', 'most', 'some'].includes(self)) throw notNow();
      return free({ type: 'self_checked', self });
    }
    default:
      throw notNow();
  }
}

// ---------------------------------------------------------------- the two journeys, uniformly

interface Journey {
  graph: Graph<any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  view: (cp: Checkpoint<any, any>, now: number) => JourneyView; // eslint-disable-line @typescript-eslint/no-explicit-any
  resolve: (r: Run, cp: Checkpoint<any, any>) => Promise<Resolved<JourneyEvent>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** What the finished session is recorded as. */
  outcome: (state: any) => { stopped: boolean }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
export const JOURNEY_RUNTIME: Record<JourneyId, Journey> = {
  explain: {
    graph: explainGraph,
    view: (cp) => explainView(cp),
    resolve: resolveExplain,
    outcome: explainOutcome,
  },
  memorise: {
    graph: memoriseGraph,
    view: memoriseView,
    resolve: resolveMemorise,
    outcome: memoriseOutcome,
  },
};

export function viewOf(s: StoredSession, now: number): SessionView {
  return {
    ...JOURNEY_RUNTIME[s.journey].view(s.cp, now),
    sessionId: s.id,
    journey: s.journey,
    status: s.status,
    node: s.cp.node,
    seq: s.cp.seq,
    billedMicro: s.billedMicro,
    startedAt: s.startedAt,
  };
}

const HTTP_STATUS: Record<string, number> = {
  not_found: 404,
  busy: 409,
  not_available: 409,
  bad_request: 400,
  insufficient_credits: 402,
  llm_error: 502,
};

export class SessionAgent extends DurableObject<Env> {
  /** One step at a time: a second tap while a model call is running is refused, not queued. */
  private busy = false;

  private load() {
    return this.ctx.storage.get<StoredSession>(KEY);
  }

  /** Called once by the Worker when the session is created (the plan is already built). */
  async begin(s: Omit<StoredSession, 'status' | 'billedMicro' | 'startedAt' | 'updatedAt'>) {
    const now = Date.now();
    const stored: StoredSession = {
      ...s,
      status: 'active',
      billedMicro: 0,
      startedAt: now,
      updatedAt: now,
    };
    await this.ctx.storage.put(KEY, stored);
    await this.ctx.storage.setAlarm(now + IDLE_MS);
    return viewOf(stored, now);
  }

  /** The current step, for resuming on any device. null = unknown or cleaned up. */
  async current(userId: string): Promise<SessionView | null> {
    const s = await this.load();
    return s && s.userId === userId ? viewOf(s, Date.now()) : null;
  }

  /** POST: one learner action. Body { me, input }. SSE when input.stream, else one JSON event. */
  override async fetch(request: Request): Promise<Response> {
    const { me, input } = (await request.json()) as { me: SessionUser; input: SessionAct };
    if (!input.stream) {
      let last: SessionEvent = { type: 'error', code: 'internal', message: 'Something went wrong' };
      await this.act(me, input, (e) => {
        if (e.type !== 'delta') last = e;
      });
      const e = last as SessionEvent;
      return Response.json(e, { status: e.type === 'error' ? (HTTP_STATUS[e.code] ?? 500) : 200 });
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    let open = true;
    const emit = (e: SessionEvent) => {
      if (!open) return;
      writer.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`)).catch(() => {
        open = false; // the app went away: finish the step anyway so the call is settled
      });
    };
    const work = this.act(me, input, emit).finally(() => {
      if (open) writer.close().catch(() => {});
    });
    this.ctx.waitUntil(work);
    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }

  private async act(me: SessionUser, input: SessionAct, emit: (e: SessionEvent) => void) {
    const s = await this.load();
    if (!s || s.userId !== me.id)
      return emit({ type: 'error', code: 'not_found', message: 'Session not found' });
    const now = Date.now();
    // A repeated request (retry after a dropped connection, a double tap) or a finished session:
    // answer with where the session is, and change nothing.
    if (input.seq !== s.cp.seq || !isOpenSession(s.status))
      return emit({ type: 'view', view: viewOf(s, now), billedMicro: 0 });
    if (this.busy)
      return emit({
        type: 'error',
        code: 'busy',
        message: 'Still working on your last step.',
        view: viewOf(s, now),
      });
    this.busy = true;
    try {
      await this.takeStep(s, me, input, now, emit);
    } catch (err) {
      console.error('session step failed', err);
      emit({
        type: 'error',
        code: 'internal',
        message: 'Something went wrong. Nothing was lost: try that step again.',
        view: viewOf(s, now),
      });
    } finally {
      this.busy = false;
    }
  }

  private async takeStep(
    s: StoredSession,
    me: SessionUser,
    input: SessionAct,
    now: number,
    emit: (e: SessionEvent) => void,
  ) {
    const db = createDb(this.env.DB);
    const j = JOURNEY_RUNTIME[s.journey];
    const prev = s.cp;
    const refuse = (code: string, message: string) =>
      emit({ type: 'error', code, message, view: viewOf(s, now) });

    let resolved: Resolved<JourneyEvent>;
    try {
      // Safety first, on everything the learner typed (decision 9.6-5): distress never reaches a
      // model; "too much" wording leads to the smaller-plan offer.
      const typed = Object.values(input.fields ?? {})
        .join('\n')
        .trim();
      const safety = typed ? await classify(this.env, typed) : null;
      if (safety?.level === 'distress') {
        const h = await handoff(db, createNotifier(this.env), me, {
          source: 'session',
          sessionId: s.id,
          rule: safety.rule,
          detector: safety.detector,
        });
        resolved = free({ type: 'distress', notified: h.told } as JourneyEvent);
      } else if (safety?.level === 'overwhelm' && listens(j.graph, prev.node, 'too_much')) {
        resolved = free({ type: 'too_much' });
      } else {
        let tutor: Promise<Tutor> | undefined;
        resolved = await j.resolve(
          {
            env: this.env,
            db,
            me,
            s,
            input,
            now,
            delta: (text) => emit({ type: 'delta', text }),
            // Who pays and which books are searched: worked out only when a model call needs it.
            tutor: () =>
              (tutor ??= askScope(
                db,
                me,
                me.role === 'admin' ? {} : { enrolmentId: s.enrolmentId ?? undefined },
              ).then((scope) => ({ env: this.env, db, me, scope }))),
          },
          prev,
        );
      }
    } catch (err) {
      if (err instanceof Refused) return refuse(err.code, err.message);
      if (err instanceof InsufficientCredits)
        return refuse(
          'insufficient_credits',
          "You're out of credits for AI replies. You can still read on, see the answer and mark yourself.",
        );
      if (!(err instanceof DistressSignal)) {
        console.warn('session model call failed', err);
        return refuse('llm_error', "The coach couldn't reply just now. Try again in a moment.");
      }
      // Third net: the model that read the text flagged it. Its reply is never shown; the call
      // it made is still accounted for.
      const h = await handoff(db, createNotifier(this.env), me, {
        source: 'session',
        sessionId: s.id,
        rule: 'tutor_flag',
        detector: 'model',
      });
      resolved = {
        event: { type: 'distress', notified: h.told } as JourneyEvent,
        billedMicro: err.billedMicro,
      };
    }

    let r;
    try {
      r = step(j.graph, prev, resolved.event);
    } catch (err) {
      if (err instanceof InvalidTransition) return refuse('not_available', notNow().message);
      throw err;
    }

    const terminal = !!j.graph.nodes[r.checkpoint.node]?.terminal;
    const outcome = terminal ? j.outcome(r.checkpoint.state) : null;
    const next: StoredSession = {
      ...s,
      cp: r.checkpoint,
      billedMicro: s.billedMicro + resolved.billedMicro,
      updatedAt: now,
      status: !terminal
        ? 'active'
        : r.checkpoint.node === 'safety'
          ? 'handoff'
          : outcome?.stopped
            ? 'stopped'
            : 'done',
    };

    // Learner records first (all safe to repeat), then the checkpoint.
    if (s.journey === 'memorise' && resolved.event.type === 'rated') {
      const state = prev.state as MemoriseState;
      const card = currentCard(state);
      if (card)
        await saveReview(db, {
          userId: s.userId,
          offeringId: s.offeringId,
          chapter: s.chapter,
          cardKey: card.key,
          box: card.box,
          rating: (resolved.event as Extract<MemoriseEvent, { type: 'rated' }>).rating,
          now,
          repeat: isRepeat(state),
        });
    }
    if (s.journey === 'explain' && terminal && r.checkpoint.node === 'micro_win') {
      const level = explainOutcome(r.checkpoint.state as ExplainState).level;
      if (level > 0) await saveMastery(db, s, level);
    }
    await recordStep(db, s.id, {
      seq: r.checkpoint.seq,
      edge: r.edge,
      from: r.from,
      to: r.checkpoint.node,
      billedMicro: resolved.billedMicro,
      totalBilledMicro: next.billedMicro,
      status: next.status,
      outcome,
    });
    await this.ctx.storage.put(KEY, next);
    await this.ctx.storage.setAlarm(now + (terminal ? KEEP_DONE_MS : IDLE_MS));
    emit({ type: 'view', view: viewOf(next, now), billedMicro: resolved.billedMicro });
  }

  /** Idle → paused (still resumable); long unused or finished → storage is cleaned up. */
  override async alarm() {
    const s = await this.load();
    if (!s) return;
    const now = Date.now();
    const idle = now - s.updatedAt;
    const db = createDb(this.env.DB);
    if (!isOpenSession(s.status)) {
      if (idle >= KEEP_DONE_MS) await this.ctx.storage.deleteAll();
      else await this.ctx.storage.setAlarm(s.updatedAt + KEEP_DONE_MS);
      return;
    }
    if (idle >= KEEP_OPEN_MS) {
      await setSessionStatus(db, s.id, 'expired');
      await this.ctx.storage.deleteAll();
      return;
    }
    if (s.status === 'active' && idle >= IDLE_MS) {
      await this.ctx.storage.put(KEY, { ...s, status: 'paused' } satisfies StoredSession);
      await setSessionStatus(db, s.id, 'paused');
    }
    await this.ctx.storage.setAlarm(
      s.status === 'active' && idle < IDLE_MS ? s.updatedAt + IDLE_MS : s.updatedAt + KEEP_OPEN_MS,
    );
  }
}
