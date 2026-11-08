import {
  DEFAULT_MODEL,
  DEFAULT_SELECTABLE_MODELS,
  LLM_TASK_IDS,
  missingCapabilities,
  modelCapabilities,
  usdPerTokenToPico,
  type LlmTask,
} from '@aicoach/core';
import { llmModels, modelRegistry, type Db } from '@aicoach/db';
import { eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { Env } from '../env';
import { audit } from '../lib/audit';
import { badRequest } from '../lib/http';
import type { SessionUser } from '../env';
import { fetchModels } from './openrouter';

export interface TaskConfig {
  task: LlmTask;
  primaryModel: string;
  fallbackModels: string[];
  maxTokens: number | null;
  temperature: number | null;
  isDefault: boolean;
}

// Per-isolate cache so a model switch takes effect within ~30 s without a redeploy.
const CACHE_MS = 30_000;
let cache: { at: number; rows: Map<string, TaskConfig> } | null = null;
export function clearRegistryCache() {
  cache = null;
}

export async function getTaskConfig(db: Db, task: LlmTask): Promise<TaskConfig> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const rows = await db.select().from(modelRegistry);
    cache = {
      at: Date.now(),
      rows: new Map(
        rows.map((r) => [
          r.task,
          {
            task: r.task as LlmTask,
            primaryModel: r.primaryModel,
            fallbackModels: r.fallbackModels ?? [],
            maxTokens: r.maxTokens,
            temperature: r.temperature,
            isDefault: false,
          },
        ]),
      ),
    };
  }
  return (
    cache.rows.get(task) ?? {
      task,
      primaryModel: DEFAULT_MODEL,
      fallbackModels: [],
      maxTokens: null,
      temperature: null,
      isDefault: true,
    }
  );
}

export async function listTaskConfigs(db: Db): Promise<TaskConfig[]> {
  clearRegistryCache();
  return Promise.all(LLM_TASK_IDS.map((t) => getTaskConfig(db, t)));
}

/** Admin changes the model for a task. Every model must exist, be selectable and fit the task. */
export async function updateTaskConfig(
  db: Db,
  actor: SessionUser,
  task: LlmTask,
  input: {
    primaryModel: string;
    fallbackModels: string[];
    maxTokens?: number | null;
    temperature?: number | null;
  },
) {
  const ids = [input.primaryModel, ...input.fallbackModels];
  if (new Set(ids).size !== ids.length) throw badRequest('A model is listed twice');
  const rows = await db.select().from(llmModels).where(inArray(llmModels.id, ids));
  for (const id of ids) {
    const m = rows.find((r) => r.id === id);
    if (!m) throw badRequest(`Unknown model "${id}". Sync the model list first.`);
    if (!m.selectable) throw badRequest(`"${id}" is not enabled for selection`);
    if (!m.available) throw badRequest(`"${id}" is no longer offered by OpenRouter`);
    const missing = missingCapabilities(task, modelCapabilities(m.inputModalities, m.supportsJson));
    if (missing.length)
      throw badRequest(`"${id}" can't do this task (missing: ${missing.join(', ')})`);
  }
  const values = {
    task,
    primaryModel: input.primaryModel,
    fallbackModels: input.fallbackModels,
    maxTokens: input.maxTokens ?? null,
    temperature: input.temperature ?? null,
    updatedBy: actor.id,
  };
  await db
    .insert(modelRegistry)
    .values(values)
    .onConflictDoUpdate({ target: modelRegistry.task, set: values });
  clearRegistryCache();
  await audit(db, actor.id, 'update_model_registry', 'model_registry', task, values);
}

/** Import OpenRouter's model list (prices, modalities). Defaults become selectable on first sync. */
export async function syncModels(env: Pick<Env, 'OPENROUTER_API_KEY'>, db: Db) {
  const models = await fetchModels(env);
  if (!models.length) throw badRequest('OpenRouter returned no models');
  const now = new Date();
  const existing = new Set(
    (await db.select({ id: llmModels.id }).from(llmModels)).map((r) => r.id),
  );
  const defaults = new Set<string>(DEFAULT_SELECTABLE_MODELS);
  const stmts = models.map((m) => {
    const values = {
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length ?? null,
      pricePromptPico: usdPerTokenToPico(m.pricing?.prompt),
      priceCompletionPico: usdPerTokenToPico(m.pricing?.completion),
      inputModalities: m.architecture?.input_modalities ?? ['text'],
      supportsJson: (m.supported_parameters ?? []).includes('response_format'),
      available: true,
      syncedAt: now,
    };
    return db
      .insert(llmModels)
      .values({ ...values, selectable: !existing.has(m.id) && defaults.has(m.id) })
      .onConflictDoUpdate({ target: llmModels.id, set: values });
  });
  // D1 batches are transactional; keep them modest in size.
  for (let i = 0; i < stmts.length; i += 50) {
    await db.batch(stmts.slice(i, i + 50) as unknown as Parameters<Db['batch']>[0]);
  }
  // Anything not refreshed by this sync is no longer offered. (Compare timestamps instead of
  // NOT IN (...ids): D1 allows at most 100 bound parameters per query.)
  await db
    .update(llmModels)
    .set({ available: false })
    .where(or(isNull(llmModels.syncedAt), lt(llmModels.syncedAt, now)));
  return { count: models.length, syncedAt: now };
}

export async function getModels(db: Db, ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(llmModels).where(inArray(llmModels.id, ids));
}

export async function setSelectable(db: Db, actor: SessionUser, id: string, selectable: boolean) {
  const row = await db
    .update(llmModels)
    .set({ selectable })
    .where(eq(llmModels.id, id))
    .returning()
    .get();
  if (!row) throw badRequest(`Unknown model "${id}"`);
  await audit(db, actor.id, selectable ? 'enable_model' : 'disable_model', 'llm_model', id);
  return row;
}
