import { formatInr, usdNanoToBilledMicro } from '@aicoach/core';
import { creditHolds, ledgerEntries, llmUsage, wallets, type Db } from '@aicoach/db';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { asBatch, InsufficientCredits, isFundsViolation } from './ledger';
import { available, getWallet, type Wallet } from './wallets';

/**
 * Hold → call → settle (architecture §6.6). A hold reserves the worst-case cost before an LLM
 * call, so concurrent calls can never overspend. The CHECK constraint on wallets makes the
 * reservation atomic: a hold that doesn't fit is rejected by the database.
 */

const HOLD_TTL_MS = 15 * 60 * 1000;

export interface Hold {
  id: string;
  requestId: string;
  wallet: Wallet;
  amountMicro: number;
  feeBps: number;
  usdInrPaise: number;
}

function startOfTodayIst(): Date {
  // Daily caps reset at midnight India time (UTC+5:30).
  const now = Date.now();
  const offset = 5.5 * 3600_000;
  const dayStart = Math.floor((now + offset) / 86_400_000) * 86_400_000 - offset;
  return new Date(dayStart);
}

async function spentTodayMicro(db: Db, walletId: string): Promise<number> {
  const row = await db
    .select({ s: sql<number>`coalesce(sum(${llmUsage.billedMicro}), 0)` })
    .from(llmUsage)
    .where(and(eq(llmUsage.walletId, walletId), gte(llmUsage.createdAt, startOfTodayIst())))
    .get();
  return Number(row?.s ?? 0);
}

/** Reserve `estimateMicro` on the first wallet in `candidates` that can afford it (spend order). */
export async function placeHold(
  db: Db,
  candidates: Wallet[],
  estimateMicro: number,
  feeBps: (w: Wallet) => number,
  usdInrPaise: number,
): Promise<Hold> {
  // Report why the first-choice wallet was refused (e.g. its daily cap), not the last fallback's reason.
  let firstReason: string | null = null;
  const refuse = (reason: string) => {
    firstReason ??= reason;
  };
  for (const candidate of candidates) {
    const w = await getWallet(db, candidate.id); // fresh balance
    if (w.dailyCapMicro != null) {
      const spent = await spentTodayMicro(db, w.id);
      if (spent + w.heldMicro + estimateMicro > w.dailyCapMicro) {
        refuse(`Today's limit for this wallet is ${formatInr(w.dailyCapMicro)}`);
        continue;
      }
    }
    if (available(w) < estimateMicro) {
      refuse(
        `Not enough credits (available ${formatInr(available(w))}, this request may need up to ${formatInr(estimateMicro)})`,
      );
      continue;
    }
    const id = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    try {
      await db.batch([
        db
          .update(wallets)
          .set({ heldMicro: sql`${wallets.heldMicro} + ${estimateMicro}` })
          .where(eq(wallets.id, w.id)),
        db.insert(creditHolds).values({
          id,
          walletId: w.id,
          amountMicro: estimateMicro,
          requestId,
          expiresAt: new Date(Date.now() + HOLD_TTL_MS),
        }),
      ]);
      return {
        id,
        requestId,
        wallet: w,
        amountMicro: estimateMicro,
        feeBps: feeBps(w),
        usdInrPaise,
      };
    } catch (err) {
      if (!isFundsViolation(err)) throw err;
      refuse('Not enough credits (other requests are using this balance right now)');
    }
  }
  throw new InsufficientCredits(firstReason ?? 'Not enough credits');
}

export interface UsageDetails {
  userId: string | null;
  task: string;
  modelRequested: string;
  modelUsed: string | null;
  generationId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  rawUsdNano: number;
  cacheHit: boolean;
  latencyMs: number;
}

/**
 * Charge the actual cost (OpenRouter cost × (1 + fee)) and release the rest of the hold.
 * If the actual cost exceeds what the wallet can cover (rare: estimate too low), the wallet is
 * charged what it has and the shortfall is recorded on the usage row (the platform absorbs it).
 */
export async function settleHold(db: Db, hold: Hold, u: UsageDetails) {
  const raw = u.cacheHit ? 0 : u.rawUsdNano;
  const billed = usdNanoToBilledMicro(raw, hold.usdInrPaise, hold.feeBps);
  const usageId = crypto.randomUUID();
  const usageRow = {
    id: usageId,
    requestId: hold.requestId,
    generationId: u.generationId,
    walletId: hold.wallet.id,
    userId: u.userId,
    task: u.task,
    modelRequested: u.modelRequested,
    modelUsed: u.modelUsed,
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    rawUsdNano: raw,
    feeBps: hold.feeBps,
    usdInrPaise: hold.usdInrPaise,
    billedMicro: billed,
    cacheStatus: (u.cacheHit ? 'hit' : 'miss') as 'hit' | 'miss',
    status: 'ok' as const,
    latencyMs: u.latencyMs,
  };

  const attempt = async (charge: number, memo: string | null) => {
    const stmts: unknown[] = [
      db
        .update(wallets)
        .set({
          heldMicro: sql`${wallets.heldMicro} - ${hold.amountMicro}`,
          balanceMicro: sql`${wallets.balanceMicro} - ${charge}`,
        })
        .where(eq(wallets.id, hold.wallet.id)),
      db.update(creditHolds).set({ status: 'settled' }).where(eq(creditHolds.id, hold.id)),
      db.insert(llmUsage).values({ ...usageRow, errorMessage: memo }),
    ];
    if (charge > 0) {
      stmts.push(
        db.insert(ledgerEntries).values({
          walletId: hold.wallet.id,
          type: 'usage',
          amountMicro: -charge,
          usageId,
          memo,
          createdBy: u.userId,
        }),
      );
    }
    await db.batch(asBatch(stmts));
  };

  try {
    await attempt(billed, null);
  } catch (err) {
    if (!isFundsViolation(err)) throw err;
    const fresh = await getWallet(db, hold.wallet.id);
    const coverable = Math.max(0, fresh.balanceMicro - (fresh.heldMicro - hold.amountMicro));
    await attempt(
      Math.min(billed, coverable),
      `shortfall ${billed - Math.min(billed, coverable)} micro absorbed by platform`,
    );
  }
  return { usageId, billedMicro: billed, rawUsdNano: raw };
}

/** Release a hold without charging (the call failed before OpenRouter charged anything). */
export async function releaseHold(
  db: Db,
  hold: Hold,
  u: Omit<UsageDetails, 'rawUsdNano' | 'cacheHit'>,
  error: string,
) {
  await db.batch([
    db
      .update(wallets)
      .set({ heldMicro: sql`${wallets.heldMicro} - ${hold.amountMicro}` })
      .where(eq(wallets.id, hold.wallet.id)),
    db
      .update(creditHolds)
      .set({ status: 'released' })
      .where(and(eq(creditHolds.id, hold.id), eq(creditHolds.status, 'held'))),
    db.insert(llmUsage).values({
      requestId: hold.requestId,
      walletId: hold.wallet.id,
      userId: u.userId,
      task: u.task,
      modelRequested: u.modelRequested,
      modelUsed: u.modelUsed,
      generationId: u.generationId,
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      rawUsdNano: 0,
      feeBps: hold.feeBps,
      usdInrPaise: hold.usdInrPaise,
      billedMicro: 0,
      status: 'error',
      errorMessage: error.slice(0, 500),
      latencyMs: u.latencyMs,
    }),
  ]);
}

/** Cron: release holds left behind by crashed requests. */
export async function expireStaleHolds(db: Db): Promise<number> {
  const stale = await db
    .select()
    .from(creditHolds)
    .where(and(eq(creditHolds.status, 'held'), lt(creditHolds.expiresAt, new Date())))
    .limit(200);
  for (const h of stale) {
    const claimed = await db
      .update(creditHolds)
      .set({ status: 'expired' })
      .where(and(eq(creditHolds.id, h.id), eq(creditHolds.status, 'held')))
      .returning({ id: creditHolds.id })
      .get();
    if (claimed) {
      await db
        .update(wallets)
        .set({ heldMicro: sql`max(0, ${wallets.heldMicro} - ${h.amountMicro})` })
        .where(eq(wallets.id, h.walletId));
    }
  }
  return stale.length;
}
