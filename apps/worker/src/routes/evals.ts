import { evalJudgeSchema, evalRunSchema } from '@aicoach/core';
import { evalRuns } from '@aicoach/db';
import { desc, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { platformWallet } from '../credits/wallets';
import type { AppBindings } from '../env';
import { audit } from '../lib/audit';
import { AppError, parseBody } from '../lib/http';
import { LlmError } from '../llm/openrouter';
import { runMeteredChat } from '../llm/run';
import { requireAuth, requireRole } from '../middleware/session';

/**
 * Eval harness support (evals/run.mjs, architecture §6.3). Admin only. The judge is an LLM task
 * (`eval_judge`) on the platform wallet; results are stored per model for the Models screen.
 */
export const evalRoutes = new Hono<AppBindings>();
evalRoutes.use('*', requireAuth, requireRole('admin'));

const JUDGE_PROMPT = `You grade a tutor's answer against a reference answer taken from the textbook.
Score 1 if the answer is correct and covers the reference's key points, 0.5 if partly correct or missing an important point, 0 if wrong or unrelated. Ignore citation markers like [S1] and formatting.
Reply with JSON only: {"score": 0 | 0.5 | 1, "reason": "<one short sentence>"}`;

evalRoutes.post('/judge', async (c) => {
  const body = await parseBody(c, evalJudgeSchema);
  try {
    const res = await runMeteredChat(c.env, c.var.db, {
      task: 'eval_judge',
      payers: [await platformWallet(c.var.db)],
      userId: c.var.user.id,
      maxTokens: 200,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        {
          role: 'user',
          content: `Question: ${body.question}\n\nReference: ${body.reference}\n\nTutor's answer: ${body.answer}`,
        },
      ],
    });
    let score = 0;
    let reason = '';
    try {
      const parsed = JSON.parse(res.content.replace(/^```(?:json)?|```$/g, '').trim()) as {
        score?: unknown;
        reason?: unknown;
      };
      score = [0, 0.5, 1].includes(Number(parsed.score)) ? Number(parsed.score) : 0;
      reason = typeof parsed.reason === 'string' ? parsed.reason : '';
    } catch {
      reason = 'Judge reply was not valid JSON';
    }
    return c.json({ score, reason });
  } catch (err) {
    if (err instanceof LlmError) throw new AppError(502, 'llm_error', err.message);
    throw err;
  }
});

evalRoutes.post('/runs', async (c) => {
  const body = await parseBody(c, evalRunSchema);
  const row = await c.var.db
    .insert(evalRuns)
    .values({ ...body, createdBy: c.var.user.id })
    .returning({ id: evalRuns.id })
    .get();
  await audit(c.var.db, c.var.user.id, 'eval_run', 'eval_run', row.id, {
    model: body.model,
    citationAccuracy: body.citationAccuracy,
    correctness: body.correctness,
  });
  return c.json(row, 201);
});

/** Latest run per model (for the Models screen). */
evalRoutes.get('/runs', async (c) => {
  const rows = await c.var.db
    .select({
      id: evalRuns.id,
      model: evalRuns.model,
      promptVersion: evalRuns.promptVersion,
      questions: evalRuns.questions,
      citationAccuracy: evalRuns.citationAccuracy,
      correctness: evalRuns.correctness,
      notes: evalRuns.notes,
      createdAt: evalRuns.createdAt,
    })
    .from(evalRuns)
    // rowid breaks the tie when two runs are saved within the same millisecond.
    .orderBy(desc(evalRuns.createdAt), sql`rowid desc`)
    .limit(200);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.model)) latest.set(r.model, r);
  return c.json([...latest.values()]);
});
