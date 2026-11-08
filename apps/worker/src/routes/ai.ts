import { LLM_TASKS, playgroundSchema, type LlmTask } from '@aicoach/core';
import { classGroups, enrolments } from '@aicoach/db';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  classWallet,
  directUserWallet,
  getWallet,
  platformWallet,
  type Wallet,
} from '../credits/wallets';
import type { AppBindings } from '../env';
import { AppError, forbidden, parseBody } from '../lib/http';
import { LlmError } from '../llm/openrouter';
import { runMeteredChat } from '../llm/run';
import { requireAuth, requireRole } from '../middleware/session';

/**
 * Phase 1 playground: lets the Admin (platform wallet) and teachers (class or own wallet) send a
 * prompt through the full metered path. Learner-facing AI starts in Phase 2 with grounded answers.
 */
export const aiRoutes = new Hono<AppBindings>();
aiRoutes.use('*', requireAuth);

aiRoutes.post('/playground', requireRole('admin', 'teacher'), async (c) => {
  const body = await parseBody(c, playgroundSchema);
  const { db, user: me } = c.var;
  let payers: Wallet[];
  if (me.role === 'admin') {
    payers = [await platformWallet(db)];
  } else if (body.classGroupId) {
    const cls = await db
      .select()
      .from(classGroups)
      .where(eq(classGroups.id, body.classGroupId))
      .get();
    const teachesIt =
      cls?.classTeacherId === me.id ||
      !!(await db
        .select({ id: enrolments.id })
        .from(enrolments)
        .where(
          and(
            eq(enrolments.userId, me.id),
            eq(enrolments.classGroupId, body.classGroupId),
            eq(enrolments.roleIn, 'teacher'),
            eq(enrolments.status, 'active'),
          ),
        )
        .get());
    if (!cls || !teachesIt) throw forbidden('You do not teach this class');
    // Spend order: the class wallet first, then the teacher's own wallet.
    payers = [await classWallet(db, cls.id), await directUserWallet(db, me.id)];
  } else {
    payers = [await directUserWallet(db, me.id)];
  }

  try {
    const res = await runMeteredChat(c.env, db, {
      task: body.task as LlmTask,
      userId: me.id,
      maxTokens: body.maxTokens,
      payers,
      messages: [
        {
          role: 'system',
          content: 'You are the AI Coach test assistant. Answer briefly and clearly.',
        },
        { role: 'user', content: body.prompt },
      ],
    });
    const wallet = await getWallet(db, res.walletId);
    return c.json({
      answer: res.content,
      task: body.task,
      taskLabel: LLM_TASKS[body.task as LlmTask].label,
      // Model and raw OpenRouter cost are shown to Admin only.
      model: me.role === 'admin' ? res.model : null,
      rawUsdNano: me.role === 'admin' ? res.rawUsdNano : null,
      billedMicro: res.billedMicro,
      cacheHit: res.cacheHit,
      tokens: { prompt: res.promptTokens, completion: res.completionTokens },
      wallet: {
        id: wallet.id,
        balanceMicro: wallet.balanceMicro,
        availableMicro: wallet.balanceMicro - wallet.heldMicro,
      },
    });
  } catch (err) {
    if (err instanceof LlmError) throw new AppError(502, 'llm_error', err.message);
    throw err;
  }
});
