import { DEFAULT_FEE_BPS, DEFAULT_USD_INR_PAISE, formatInr } from '@aicoach/core';
import {
  allotmentEdits,
  allotments,
  ledgerEntries,
  platformSettings,
  wallets,
  type Db,
} from '@aicoach/db';
import { and, eq, sql } from 'drizzle-orm';
import type { SessionUser } from '../env';
import { audit } from '../lib/audit';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/http';
import { canManage, getWallet, isReceiver, platformWallet, type Wallet } from './wallets';

/**
 * Credit movements (architecture §6.6). Every change is one D1 batch (a transaction).
 * The wallets table has CHECK(held >= 0 AND balance >= held), so the database itself rejects
 * any batch that would overspend, and the whole batch rolls back.
 */

export class InsufficientCredits extends AppError {
  constructor(message = 'Not enough credits') {
    super(402, 'insufficient_credits', message);
  }
}

export function isFundsViolation(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`
      : String(err);
  return text.includes('CHECK constraint failed');
}

/** Drizzle's batch() wants a non-empty tuple type; dynamic statement lists go through this. */
export type BatchStatements = Parameters<Db['batch']>[0];
export const asBatch = (statements: unknown[]) => statements as unknown as BatchStatements;

async function runBatch(
  db: Db,
  statements: Parameters<Db['batch']>[0],
  insufficientMessage: string,
) {
  try {
    await db.batch(statements);
  } catch (err) {
    if (isFundsViolation(err)) throw new InsufficientCredits(insufficientMessage);
    throw err;
  }
}

const addToBalance = (db: Db, walletId: string, delta: number) =>
  db
    .update(wallets)
    .set({ balanceMicro: sql`${wallets.balanceMicro} + ${delta}` })
    .where(eq(wallets.id, walletId));

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

async function getIntSetting(db: Db, key: string, fallback: number): Promise<number> {
  const row = await db.select().from(platformSettings).where(eq(platformSettings.key, key)).get();
  const n = row ? Number(row.value) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

async function setIntSetting(db: Db, actor: SessionUser, key: string, value: number) {
  await db
    .insert(platformSettings)
    .values({ key, value: String(value), updatedBy: actor.id })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: String(value), updatedBy: actor.id },
    });
  await audit(db, actor.id, `set_${key}`, 'platform_settings', key, { value });
}

/** Platform usage fee in basis points (Admin-only; never shown to other roles). */
export const getFeeBps = (db: Db) => getIntSetting(db, 'fee_bps', DEFAULT_FEE_BPS);
export const setFeeBps = (db: Db, actor: SessionUser, feeBps: number) =>
  setIntSetting(db, actor, 'fee_bps', feeBps);

/** USD→INR conversion rate in paise per US$ (Admin-only). Applies to new calls only. */
export const getUsdInrPaise = (db: Db) => getIntSetting(db, 'usd_inr_paise', DEFAULT_USD_INR_PAISE);
export const setUsdInrPaise = (db: Db, actor: SessionUser, paise: number) =>
  setIntSetting(db, actor, 'usd_inr_paise', paise);

/** The platform wallet pays its own (ingestion / admin) usage at cost: no fee on itself. */
export const feeFor = (w: Wallet, feeBps: number) => (w.ownerType === 'platform' ? 0 : feeBps);

// ---------------------------------------------------------------------------------------------
// Issue (Admin), allot (down the tree), edit, acknowledge, lock
// ---------------------------------------------------------------------------------------------

/** Admin issues new credits (backed by an offline payment) into a top-level wallet. */
export async function issueCredits(
  db: Db,
  actor: SessionUser,
  to: Wallet,
  amountMicro: number,
  opts: { paymentId?: string; note?: string; extra?: unknown[]; allotmentId?: string } = {},
) {
  if (actor.role !== 'admin') throw forbidden('Only an Admin can issue credits');
  if (amountMicro <= 0) throw badRequest('Amount must be more than 0');
  const platform = await platformWallet(db);
  if (to.id !== platform.id && to.parentWalletId !== platform.id) {
    throw badRequest(
      'Admins issue credits to the platform, an institution or a direct user; others receive them down the tree',
    );
  }
  const allotmentId = opts.allotmentId ?? crypto.randomUUID();
  await runBatch(
    db,
    [
      db.insert(allotments).values({
        id: allotmentId,
        fromWalletId: null,
        toWalletId: to.id,
        amountMicro,
        paymentId: opts.paymentId ?? null,
        note: opts.note ?? null,
        createdBy: actor.id,
      }),
      addToBalance(db, to.id, amountMicro),
      db
        .insert(ledgerEntries)
        .values({ walletId: to.id, type: 'issue', amountMicro, allotmentId, createdBy: actor.id }),
      ...(opts.extra ?? []),
    ] as unknown as BatchStatements,
    'Not enough credits',
  );
  await audit(db, actor.id, 'issue_credits', 'wallet', to.id, {
    amountMicro,
    allotmentId,
    paymentId: opts.paymentId,
  });
  return allotmentId;
}

/** Transfer credits from a wallet to one of its direct children (POC → class, teacher → student). */
export async function allotCredits(
  db: Db,
  actor: SessionUser,
  from: Wallet,
  to: Wallet,
  amountMicro: number,
  note?: string,
  /** Extra statements to commit atomically with the transfer (e.g. closing a credit request). */
  opts: { extra?: unknown[]; allotmentId?: string } = {},
) {
  if (amountMicro <= 0) throw badRequest('Amount must be more than 0');
  if (!(await canManage(db, actor, from)))
    throw forbidden('You cannot give credits from this wallet');
  if (to.parentWalletId !== from.id)
    throw badRequest('Credits can only be given to your immediate downline');
  const allotmentId = opts.allotmentId ?? crypto.randomUUID();
  await runBatch(
    db,
    [
      db.insert(allotments).values({
        id: allotmentId,
        fromWalletId: from.id,
        toWalletId: to.id,
        amountMicro,
        note: note ?? null,
        createdBy: actor.id,
      }),
      addToBalance(db, from.id, -amountMicro),
      addToBalance(db, to.id, amountMicro),
      db.insert(ledgerEntries).values([
        {
          walletId: from.id,
          type: 'allot_out',
          amountMicro: -amountMicro,
          allotmentId,
          createdBy: actor.id,
        },
        { walletId: to.id, type: 'allot_in', amountMicro, allotmentId, createdBy: actor.id },
      ]),
      ...(opts.extra ?? []),
    ] as unknown as BatchStatements,
    `Not enough credits. Available: ${formatInr(from.balanceMicro - from.heldMicro)}`,
  );
  await audit(db, actor.id, 'allot_credits', 'wallet', to.id, {
    from: from.id,
    amountMicro,
    allotmentId,
  });
  return allotmentId;
}

async function loadAllotment(db: Db, id: string) {
  const a = await db.select().from(allotments).where(eq(allotments.id, id)).get();
  if (!a) throw notFound('Allotment');
  return a;
}

/** The giver of an allotment: Admin for issuances, otherwise whoever manages the source wallet. */
async function isGiver(db: Db, actor: SessionUser, a: typeof allotments.$inferSelect) {
  if (!a.fromWalletId) return actor.role === 'admin';
  return canManage(db, actor, await getWallet(db, a.fromWalletId));
}

/**
 * Giver corrects the amount while the allotment is open (e.g. a typo). The edit clears any
 * acknowledgement, so the receiver must confirm the corrected amount again (decision 9.2-3).
 */
export async function editAllotment(
  db: Db,
  actor: SessionUser,
  id: string,
  newAmountMicro: number,
  reason: string,
) {
  const a = await loadAllotment(db, id);
  if (!(await isGiver(db, actor, a))) throw forbidden('Only the giver can edit this allotment');
  if (a.status === 'locked')
    throw conflict('This allotment is locked and can no longer be changed');
  if (newAmountMicro < 0) throw badRequest('Amount cannot be negative');
  const delta = newAmountMicro - a.amountMicro;
  if (delta === 0) throw badRequest('The amount is unchanged');

  // Guarded update: only applies if nobody changed or locked it in the meantime.
  const updated = await db
    .update(allotments)
    .set({ amountMicro: newAmountMicro, acknowledgedAt: null, acknowledgedBy: null })
    .where(
      and(
        eq(allotments.id, id),
        eq(allotments.status, 'open'),
        eq(allotments.amountMicro, a.amountMicro),
      ),
    )
    .returning({ id: allotments.id })
    .get();
  if (!updated) throw conflict('This allotment changed meanwhile. Reload and try again');

  const money = [
    addToBalance(db, a.toWalletId, delta),
    db.insert(ledgerEntries).values({
      walletId: a.toWalletId,
      type: delta > 0 ? 'edit_in' : 'edit_out',
      amountMicro: delta,
      allotmentId: id,
      memo: reason,
      createdBy: actor.id,
    }),
    db.insert(allotmentEdits).values({
      allotmentId: id,
      oldAmountMicro: a.amountMicro,
      newAmountMicro,
      reason,
      editedBy: actor.id,
    }),
  ];
  if (a.fromWalletId) {
    money.push(
      addToBalance(db, a.fromWalletId, -delta),
      db.insert(ledgerEntries).values({
        walletId: a.fromWalletId,
        type: delta > 0 ? 'edit_out' : 'edit_in',
        amountMicro: -delta,
        allotmentId: id,
        memo: reason,
        createdBy: actor.id,
      }),
    );
  }
  try {
    await runBatch(
      db,
      asBatch(money),
      delta > 0
        ? 'Not enough credits to increase this allotment'
        : "The receiver has already used some of these credits, so it can't be reduced that much",
    );
  } catch (err) {
    // Money didn't move: put the allotment back as it was.
    await db
      .update(allotments)
      .set({
        amountMicro: a.amountMicro,
        acknowledgedAt: a.acknowledgedAt,
        acknowledgedBy: a.acknowledgedBy,
      })
      .where(eq(allotments.id, id));
    throw err;
  }
  await audit(db, actor.id, 'edit_allotment', 'allotment', id, {
    from: a.amountMicro,
    to: newAmountMicro,
    reason,
  });
}

/** Receiver confirms they received the right amount. */
export async function acknowledgeAllotment(db: Db, actor: SessionUser, id: string) {
  const a = await loadAllotment(db, id);
  const to = await getWallet(db, a.toWalletId);
  if (!(await isReceiver(db, actor, to)))
    throw forbidden('Only the receiver can confirm this allotment');
  if (a.status === 'locked') throw conflict('Already locked');
  if (a.acknowledgedAt) return;
  await db
    .update(allotments)
    .set({ acknowledgedAt: new Date(), acknowledgedBy: actor.id })
    .where(
      and(
        eq(allotments.id, id),
        eq(allotments.status, 'open'),
        eq(allotments.amountMicro, a.amountMicro),
      ),
    );
  await audit(db, actor.id, 'acknowledge_allotment', 'allotment', id, {
    amountMicro: a.amountMicro,
  });
}

/** Giver locks after the receiver acknowledged. Locked allotments can never change. */
export async function lockAllotment(db: Db, actor: SessionUser, id: string) {
  const a = await loadAllotment(db, id);
  if (!(await isGiver(db, actor, a))) throw forbidden('Only the giver can lock this allotment');
  if (a.status === 'locked') return;
  if (!a.acknowledgedAt)
    throw conflict('The receiver must confirm the amount before it can be locked');
  const done = await db
    .update(allotments)
    .set({ status: 'locked', lockedAt: new Date(), lockedBy: actor.id })
    .where(
      and(
        eq(allotments.id, id),
        eq(allotments.status, 'open'),
        sql`${allotments.acknowledgedAt} IS NOT NULL`,
      ),
    )
    .returning({ id: allotments.id })
    .get();
  if (!done) throw conflict('This allotment changed meanwhile. Reload and try again');
  await audit(db, actor.id, 'lock_allotment', 'allotment', id, { amountMicro: a.amountMicro });
}
