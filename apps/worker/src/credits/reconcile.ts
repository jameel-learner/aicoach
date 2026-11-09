import { usdNanoToBilledMicro, usdToNano } from '@aicoach/core';
import { ledgerEntries, llmUsage, wallets, type Db } from '@aicoach/db';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Env } from '../env';
import { openRouterBase } from '../llm/openrouter';
import { isFundsViolation } from './ledger';

/**
 * Reconciliation (architecture §6.6 step 5): compare what we charged with OpenRouter's own record
 * of each call (generation stats). Differences become `adjust` ledger entries (refund or extra
 * charge at the call's own rate and fee). Runs hourly on calls older than a few minutes.
 * Exit criterion (Phase 2): total difference < 0.5%.
 */

const BATCH = 40;
const MIN_AGE_MS = 5 * 60_000; // generation stats appear shortly after a call

async function fetchGenerationCost(env: Env, generationId: string): Promise<number | null> {
  const res = await fetch(
    `${openRouterBase(env)}/generation?id=${encodeURIComponent(generationId)}`,
    {
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
    },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: { total_cost?: unknown } };
  return typeof body.data?.total_cost === 'number' ? body.data.total_cost : null;
}

export async function reconcileUsage(env: Env, db: Db, now = Date.now()) {
  if (!env.OPENROUTER_API_KEY) return { checked: 0, adjusted: 0 };
  const rows = await db
    .select()
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.status, 'ok'),
        eq(llmUsage.cacheStatus, 'miss'),
        isNotNull(llmUsage.generationId),
        isNull(llmUsage.reconciledAt),
        lt(llmUsage.createdAt, new Date(now - MIN_AGE_MS)),
      ),
    )
    .limit(BATCH);
  let adjusted = 0;
  for (const u of rows) {
    const cost = await fetchGenerationCost(env, u.generationId!);
    if (cost === null) continue; // not available yet; try again next hour
    const actual = usdToNano(cost);
    const diffNano = actual - u.rawUsdNano;
    const stamp = db
      .update(llmUsage)
      .set({ reconciledAt: new Date(now), reconciledUsdNano: actual })
      .where(eq(llmUsage.id, u.id));
    const diffMicro =
      Math.sign(diffNano) * usdNanoToBilledMicro(Math.abs(diffNano), u.usdInrPaise, u.feeBps);
    if (diffMicro === 0) {
      await stamp;
      continue;
    }
    const memo = `Reconciled with OpenRouter: actual $${(actual / 1e9).toFixed(6)} vs charged $${(u.rawUsdNano / 1e9).toFixed(6)}`;
    try {
      await db.batch([
        stamp,
        db
          .update(wallets)
          .set({ balanceMicro: sql`${wallets.balanceMicro} - ${diffMicro}` })
          .where(eq(wallets.id, u.walletId)),
        db.insert(ledgerEntries).values({
          walletId: u.walletId,
          type: 'adjust',
          amountMicro: -diffMicro,
          usageId: u.id,
          memo,
        }),
      ]);
      adjusted++;
    } catch (err) {
      if (!isFundsViolation(err)) throw err;
      // The wallet can't cover the extra charge: record the check, the platform absorbs it.
      await db
        .update(llmUsage)
        .set({
          reconciledAt: new Date(now),
          reconciledUsdNano: actual,
          errorMessage: `${memo}; not charged (wallet empty)`,
        })
        .where(eq(llmUsage.id, u.id));
    }
  }
  return { checked: rows.length, adjusted };
}

/** For the Admin float panel: how far our charges are from OpenRouter's records (last 30 days). */
export async function reconciliationSummary(db: Db, now = Date.now()) {
  const r = await db
    .select({
      n: sql<number>`count(*)`,
      charged: sql<number>`coalesce(sum(${llmUsage.rawUsdNano}), 0)`,
      actual: sql<number>`coalesce(sum(${llmUsage.reconciledUsdNano}), 0)`,
    })
    .from(llmUsage)
    .where(
      and(isNotNull(llmUsage.reconciledAt), sql`${llmUsage.createdAt} >= ${now - 30 * 86_400_000}`),
    )
    .get();
  const charged = Number(r?.charged ?? 0);
  const actual = Number(r?.actual ?? 0);
  return {
    calls: Number(r?.n ?? 0),
    chargedUsdNano: charged,
    actualUsdNano: actual,
    differencePct: actual ? (Math.abs(actual - charged) / actual) * 100 : 0,
  };
}
