import { createDb } from '@aicoach/db';
import { expireStaleHolds } from './credits/meter';
import { reconcileUsage } from './credits/reconcile';
import type { Env } from './env';
import { syncModels } from './llm/registry';

/** Cron triggers (wrangler.jsonc `triggers.crons`). */
export const CRON_HOURLY = '0 * * * *'; // release stale credit holds; reconcile with OpenRouter
export const CRON_NIGHTLY = '30 20 * * *'; // 02:00 IST: sync OpenRouter models & prices

export async function runScheduled(cron: string, env: Env) {
  const db = createDb(env.DB);
  if (cron === CRON_HOURLY) {
    const n = await expireStaleHolds(db);
    if (n) console.log(`expired ${n} stale credit holds`);
    const r = await reconcileUsage(env, db);
    if (r.checked) console.log(`reconciled ${r.checked} calls, ${r.adjusted} adjusted`);
  }
  if (cron === CRON_NIGHTLY && env.OPENROUTER_API_KEY) {
    const r = await syncModels(env, db);
    console.log(`synced ${r.count} OpenRouter models`);
  }
}
