import { answers } from '@aicoach/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../env';
import { audit } from '../lib/audit';
import { parseBody } from '../lib/http';
import { getTaskConfig } from '../llm/registry';
import { TUTOR_ANSWER } from '../llm/prompts';
import { requireAuth, requireRole } from '../middleware/session';

/**
 * Admin: saved answers of "Ask your textbook" (decision 9.5-3). Answers are reused only from the
 * current generator (configured tutor model + prompt version); "Stop reusing" retires a
 * generator's answers (kept as history, never deleted).
 */
export const savedAnswerRoutes = new Hono<AppBindings>();
savedAnswerRoutes.use('*', requireAuth, requireRole('admin'));

savedAnswerRoutes.get('/', async (c) => {
  const { db } = c.var;
  const current = `${(await getTaskConfig(db, 'tutor_chat')).primaryModel}|${TUTOR_ANSWER.version}`;
  const rows = await db
    .select({
      generator: answers.generator,
      total: sql<number>`count(*)`,
      reusable: sql<number>`sum(case when ${answers.retiredAt} is null then 1 else 0 end)`,
      reused: sql<number>`coalesce(sum(${answers.hits}), 0)`,
      lastAt: sql<number>`max(${answers.createdAt})`,
    })
    .from(answers)
    .groupBy(answers.generator)
    .orderBy(desc(sql`max(${answers.createdAt})`));
  return c.json({
    current,
    generators: rows.map((r) => {
      const [model, promptVersion] = r.generator.split('|');
      return {
        generator: r.generator,
        model: model || '(unknown)',
        promptVersion: promptVersion ?? '',
        total: Number(r.total),
        reusable: Number(r.reusable),
        reused: Number(r.reused),
        lastAt: r.lastAt ? new Date(Number(r.lastAt)).toISOString() : null,
        current: r.generator === current,
      };
    }),
  });
});

const retireSchema = z.object({ generator: z.string().min(1).max(200) });

/** Stop reusing a generator's saved answers (e.g. after fixing a textbook page). */
savedAnswerRoutes.post('/retire', async (c) => {
  const { db, user: me } = c.var;
  const { generator } = await parseBody(c, retireSchema);
  const res = await db
    .update(answers)
    .set({ retiredAt: new Date() })
    .where(and(eq(answers.generator, generator), isNull(answers.retiredAt)))
    .returning({ id: answers.id });
  await audit(db, me.id, 'retire_saved_answers', 'answers', generator, { count: res.length });
  return c.json({ retired: res.length });
});
