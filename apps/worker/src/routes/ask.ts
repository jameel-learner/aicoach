import { askSchema } from '@aicoach/core';
import { Hono } from 'hono';
import { answerQuestion, type AskEvent } from '../content/answer';
import { askScope } from '../content/scope';
import { InsufficientCredits } from '../credits/ledger';
import type { AppBindings } from '../env';
import { AppError, badRequest, parseBody } from '../lib/http';
import { LlmError } from '../llm/openrouter';
import { requireAuth } from '../middleware/session';

/**
 * "Ask your textbook" (architecture §3.6, §7 Phase 2).
 * POST /api/ask → Server-Sent Events: meta → delta* → done (or error). With stream:false, JSON.
 * The answer is settled at OpenRouter's real cost even if the client disconnects mid-stream.
 */
export const askRoutes = new Hono<AppBindings>();
askRoutes.use('*', requireAuth);

/** What this user's questions search, for the UI ("Searching: NCERT Accountancy Part I, II"). */
askRoutes.get('/scope', async (c) => {
  const scope = await askScope(c.var.db, c.var.user, {
    enrolmentId: c.req.query('enrolmentId') || undefined,
    classGroupId: c.req.query('classGroupId') || undefined,
  });
  return c.json({
    books: scope.books.map((b) => ({ id: b.id, title: b.title, version: b.version })),
    context: scope.context,
  });
});

askRoutes.post('/', async (c) => {
  const body = await parseBody(c, askSchema);
  const { db, user: me } = c.var;
  const scope = await askScope(db, me, body);
  if (!scope.books.length)
    throw badRequest('No textbook is set up for you yet. Ask your teacher or the institution.');

  if (!body.stream) {
    let done: Extract<AskEvent, { type: 'done' }> | null = null;
    try {
      await answerQuestion(c.env, db, me, scope, body, (e) => {
        if (e.type === 'done') done = e;
      });
    } catch (err) {
      if (err instanceof LlmError) throw new AppError(502, 'llm_error', err.message);
      throw err;
    }
    return c.json(done);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let open = true;
  const emit = (e: AskEvent) => {
    if (!open) return;
    writer.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`)).catch(() => {
      open = false; // client went away: keep going so the call is settled
    });
  };
  const work = answerQuestion(c.env, db, me, scope, body, emit)
    .catch((err: unknown) => {
      const code = err instanceof InsufficientCredits ? 'insufficient_credits' : 'llm_error';
      const message = err instanceof Error ? err.message : 'Something went wrong';
      emit({ type: 'error', code, message });
      if (!(err instanceof InsufficientCredits) && !(err instanceof LlmError)) console.error(err);
    })
    .finally(() => {
      if (open) writer.close().catch(() => {});
    });
  c.executionCtx.waitUntil(work);
  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
});
