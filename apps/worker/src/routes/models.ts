import {
  LLM_TASKS,
  isLlmTask,
  missingCapabilities,
  modelCapabilities,
  modelSelectableSchema,
  registryUpdateSchema,
} from '@aicoach/core';
import { llmModels } from '@aicoach/db';
import { asc, eq, like, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../env';
import { badRequest, parseBody } from '../lib/http';
import { listTaskConfigs, setSelectable, syncModels, updateTaskConfig } from '../llm/registry';
import { requireAuth, requireRole } from '../middleware/session';

/** Admin: model switching per task (architecture §6.5). */
export const modelRoutes = new Hono<AppBindings>();
modelRoutes.use('*', requireAuth, requireRole('admin'));

const view = (m: typeof llmModels.$inferSelect) => {
  const caps = modelCapabilities(m.inputModalities, m.supportsJson);
  return {
    id: m.id,
    name: m.name,
    contextLength: m.contextLength,
    // USD per million tokens, for display
    promptUsdPerM: m.pricePromptPico / 1e6,
    completionUsdPerM: m.priceCompletionPico / 1e6,
    capabilities: caps,
    selectable: m.selectable,
    available: m.available,
    syncedAt: m.syncedAt,
  };
};

modelRoutes.get('/', async (c) => {
  const { db } = c.var;
  const models = (
    await db
      .select()
      .from(llmModels)
      .where(eq(llmModels.selectable, true))
      .orderBy(asc(llmModels.id))
  ).map(view);
  const configs = await listTaskConfigs(db);
  const lastSync = await db
    .select({ t: llmModels.syncedAt })
    .from(llmModels)
    .orderBy(asc(llmModels.syncedAt))
    .limit(1)
    .get();
  return c.json({
    tasks: configs.map((cfg) => ({
      ...cfg,
      label: LLM_TASKS[cfg.task].label,
      needs: LLM_TASKS[cfg.task].needs,
      // Options the picker may offer for this task (capability filter).
      options: models
        .filter((m) => m.available && missingCapabilities(cfg.task, m.capabilities).length === 0)
        .map((m) => m.id),
      // Eval scores per model arrive with the eval harness (Phase 2).
      evalScores: null,
    })),
    models,
    catalogSize: (await db.select({ id: llmModels.id }).from(llmModels)).length,
    lastSyncedAt: lastSync?.t ?? null,
  });
});

modelRoutes.post('/sync', async (c) => c.json(await syncModels(c.env, c.var.db)));

modelRoutes.get('/catalog', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q || q.length < 2) return c.json([]);
  const rows = await c.var.db
    .select()
    .from(llmModels)
    .where(or(like(llmModels.id, `%${q}%`), like(llmModels.name, `%${q}%`)))
    .orderBy(asc(llmModels.id))
    .limit(30);
  return c.json(rows.map(view));
});

modelRoutes.put('/selectable', async (c) => {
  const body = await parseBody(c, modelSelectableSchema.extend({ id: z.string().min(3) }));
  return c.json(view(await setSelectable(c.var.db, c.var.user, body.id, body.selectable)));
});

modelRoutes.put('/registry/:task', async (c) => {
  const task = c.req.param('task');
  if (!isLlmTask(task)) throw badRequest('Unknown task');
  const body = await parseBody(c, registryUpdateSchema);
  await updateTaskConfig(c.var.db, c.var.user, task, body);
  return c.json({ ok: true });
});
