import { formatInr, parseRupeesToMicro, PAYMENT_METHODS } from '@aicoach/core';
import { creditRequests, payments, user, wallets, type Db } from '@aicoach/db';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { SessionUser } from '../env';
import { audit } from '../lib/audit';
import { creditRequestDecisionEmail, creditRequestEmail } from '../lib/emails';
import { badRequest, conflict, forbidden, notFound } from '../lib/http';
import type { Notifier } from '../lib/notifier';
import { allotCredits, issueCredits } from './ledger';
import {
  canManage,
  directUserWallet,
  getWallet,
  isReceiver,
  walletLabel,
  walletManagers,
  type Wallet,
} from './wallets';

/**
 * Credit requests (architecture §6.6, decision 9.3-1).
 *  - To the parent wallet's managers (student → teacher, class → POC): accept = automatic allotment.
 *  - To Admin (institution or direct wallets): must carry the payment UTR. It creates a pending
 *    payment; Admin verifies it, and confirming issues the credits.
 */

type Method = (typeof PAYMENT_METHODS)[number];
export type CreditRequestRow = typeof creditRequests.$inferSelect;

function toMicro(amount: string) {
  try {
    return parseRupeesToMicro(amount);
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : 'Invalid amount');
  }
}

/** Where a wallet's requests go: 'admin', 'parent' (teacher/POC), or null (platform: can't request). */
export async function requestTarget(db: Db, w: Wallet) {
  if (!w.parentWalletId) return null;
  const parent = await getWallet(db, w.parentWalletId);
  return parent.ownerType === 'platform'
    ? ({ toAdmin: true, label: 'AI Coach (Admin)' } as const)
    : ({ toAdmin: false, label: await walletLabel(db, parent) } as const);
}

export async function createCreditRequest(
  db: Db,
  notifier: Notifier,
  appUrl: string,
  me: SessionUser,
  input: {
    walletId?: string;
    credits: string;
    message?: string;
    payment?: { reference: string; method: Method; paidOn: string };
  },
) {
  let w: Wallet;
  if (input.walletId) w = await getWallet(db, input.walletId);
  else if (me.role === 'student' || me.role === 'teacher') w = await directUserWallet(db, me.id);
  else throw badRequest('Choose the wallet to add credits to');
  if (!(await isReceiver(db, me, w)))
    throw forbidden('You can only ask for credits for your own wallet');
  if (!w.parentWalletId)
    throw badRequest('The platform wallet is topped up by recording a payment');
  const parent = await getWallet(db, w.parentWalletId);
  const toAdmin = parent.ownerType === 'platform';
  const amountMicro = toMicro(input.credits);

  const open = await db
    .select({ id: creditRequests.id })
    .from(creditRequests)
    .where(and(eq(creditRequests.walletId, w.id), eq(creditRequests.status, 'pending')))
    .get();
  if (open)
    throw conflict(
      'You already have a pending request for this wallet. Wait for a reply or cancel it',
    );

  const requestId = crypto.randomUUID();
  let paymentId: string | null = null;
  const stmts: unknown[] = [];
  if (toAdmin) {
    const p = input.payment;
    if (!p) throw badRequest('Enter the UTR / reference of your payment so Admin can verify it');
    if (amountMicro % 10_000 !== 0)
      throw badRequest('Enter the amount you paid, in rupees and paise');
    const dup = await db
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.reference, p.reference), ne(payments.status, 'rejected')))
      .get();
    if (dup) throw conflict('This UTR has already been submitted');
    paymentId = crypto.randomUUID();
    stmts.push(
      db.insert(payments).values({
        id: paymentId,
        kind: 'credit_purchase',
        payerType: w.ownerType === 'institution' ? 'institution' : 'user',
        institutionId: w.ownerType === 'institution' ? w.institutionId : null,
        userId: w.ownerType === 'institution' ? null : me.id,
        amountMinor: amountMicro / 10_000, // paise
        currency: 'INR',
        method: p.method,
        reference: p.reference,
        paidOn: p.paidOn,
        note: input.message ?? null,
        recordedBy: me.id,
        status: 'pending',
      }),
    );
  }
  stmts.push(
    db.insert(creditRequests).values({
      id: requestId,
      walletId: w.id,
      parentWalletId: parent.id,
      toAdmin,
      requestedBy: me.id,
      amountMicro,
      message: input.message ?? null,
      paymentId,
    }),
  );
  await db.batch(stmts as unknown as Parameters<Db['batch']>[0]);
  await audit(db, me.id, 'request_credits', 'wallet', w.id, { requestId, amountMicro, paymentId });

  try {
    const label = await walletLabel(db, w);
    for (const m of await walletManagers(db, parent)) {
      await notifier.send(
        creditRequestEmail({
          to: m.email,
          name: m.name,
          requester: me.name,
          walletLabel: label,
          amount: formatInr(amountMicro),
          message: input.message,
          payment: toAdmin ? input.payment : undefined,
          appUrl,
        }),
      );
    }
  } catch (err) {
    console.error('credit request notification failed', err);
  }
  return { id: requestId, toAdmin };
}

async function loadRequest(db: Db, id: string) {
  const r = await db.select().from(creditRequests).where(eq(creditRequests.id, id)).get();
  if (!r) throw notFound('Request');
  return r;
}

/** Accept (allot / issue automatically) or reject (with a comment) a pending request. */
export async function decideCreditRequest(
  db: Db,
  notifier: Notifier,
  appUrl: string,
  me: SessionUser,
  id: string,
  input: { decision: 'approve' | 'reject'; credits?: string; note?: string },
) {
  const r = await loadRequest(db, id);
  const parent = await getWallet(db, r.parentWalletId);
  if (r.toAdmin ? me.role !== 'admin' : !(await canManage(db, me, parent)))
    throw forbidden('Only the level above can decide this request');
  if (r.status !== 'pending') throw conflict(`This request is already ${r.status}`);
  const note = input.note?.trim() || null;

  // Claim the request first so two people can't both approve it.
  const claimed = await db
    .update(creditRequests)
    .set({
      status: input.decision === 'approve' ? 'approved' : 'rejected',
      decidedBy: me.id,
      decidedAt: new Date(),
      decisionNote: note,
    })
    .where(and(eq(creditRequests.id, id), eq(creditRequests.status, 'pending')))
    .returning({ id: creditRequests.id })
    .get();
  if (!claimed) throw conflict('This request was decided meanwhile. Reload');

  const target = await getWallet(db, r.walletId);
  let granted = 0;
  try {
    if (input.decision === 'reject') {
      if (r.paymentId)
        await db
          .update(payments)
          .set({ status: 'rejected', verifiedBy: me.id, verifiedAt: new Date() })
          .where(eq(payments.id, r.paymentId));
    } else {
      granted = input.credits ? toMicro(input.credits) : r.amountMicro;
      const allotmentId = crypto.randomUUID();
      const close = db
        .update(creditRequests)
        .set({ grantedMicro: granted, allotmentId })
        .where(eq(creditRequests.id, id));
      if (r.toAdmin) {
        const verify = r.paymentId
          ? [
              db
                .update(payments)
                .set({ status: 'verified', verifiedBy: me.id, verifiedAt: new Date() })
                .where(eq(payments.id, r.paymentId)),
            ]
          : [];
        await issueCredits(db, me, target, granted, {
          paymentId: r.paymentId ?? undefined,
          note: note ?? undefined,
          allotmentId,
          extra: [close, ...verify],
        });
      } else {
        await allotCredits(db, me, parent, target, granted, note ?? undefined, {
          allotmentId,
          extra: [close],
        });
      }
    }
  } catch (err) {
    // Nothing moved: reopen the request so it can be decided again.
    await db
      .update(creditRequests)
      .set({ status: 'pending', decidedBy: null, decidedAt: null, decisionNote: null })
      .where(eq(creditRequests.id, id));
    throw err;
  }
  await audit(db, me.id, `${input.decision}_credit_request`, 'credit_request', id, {
    granted,
    note,
  });

  try {
    const label = await walletLabel(db, target);
    const requester = await db.select().from(user).where(eq(user.id, r.requestedBy)).get();
    if (requester)
      await notifier.send(
        creditRequestDecisionEmail({
          to: requester.email,
          name: requester.name,
          approved: input.decision === 'approve',
          requested: formatInr(r.amountMicro),
          granted: formatInr(granted),
          walletLabel: label,
          note,
          appUrl,
        }),
      );
  } catch (err) {
    console.error('credit decision notification failed', err);
  }
  return { status: input.decision === 'approve' ? 'approved' : 'rejected', grantedMicro: granted };
}

export async function cancelCreditRequest(db: Db, me: SessionUser, id: string) {
  const r = await loadRequest(db, id);
  if (r.requestedBy !== me.id) throw forbidden('Only the requester can cancel this request');
  const done = await db
    .update(creditRequests)
    .set({ status: 'cancelled', decidedBy: me.id, decidedAt: new Date() })
    .where(and(eq(creditRequests.id, id), eq(creditRequests.status, 'pending')))
    .returning({ id: creditRequests.id })
    .get();
  if (!done) throw conflict('Only a pending request can be cancelled');
  if (r.paymentId)
    await db
      .update(payments)
      .set({ status: 'rejected', note: 'Cancelled by the payer' })
      .where(and(eq(payments.id, r.paymentId), eq(payments.status, 'pending')));
}

/**
 * Requests visible to a user:
 *  - mine:  requests I made (any wallet)
 *  - inbox: requests to wallets I manage. Admin: requests that come to Admin (payments to verify).
 */
export async function listCreditRequests(
  db: Db,
  me: SessionUser,
  scope: 'mine' | 'inbox',
  managedWalletIds: string[],
) {
  let where;
  if (scope === 'mine') where = eq(creditRequests.requestedBy, me.id);
  else if (me.role === 'admin') where = eq(creditRequests.toAdmin, true);
  else {
    if (!managedWalletIds.length) return [];
    // Managed wallets per user are few (one per class / institution), well under D1's 100 params.
    where = and(
      inArray(creditRequests.parentWalletId, managedWalletIds.slice(0, 90)),
      eq(creditRequests.toAdmin, false),
    );
  }
  const rows = await db
    .select({ r: creditRequests, requesterName: user.name, requesterEmail: user.email })
    .from(creditRequests)
    .leftJoin(user, eq(user.id, creditRequests.requestedBy))
    .where(where)
    .orderBy(desc(creditRequests.createdAt))
    .limit(100);
  if (!rows.length) return [];

  const walletIds = [...new Set(rows.flatMap((x) => [x.r.walletId, x.r.parentWalletId]))];
  const ws = await db
    .select()
    .from(wallets)
    .where(inArray(wallets.id, walletIds.slice(0, 95)));
  const labels = new Map<string, string>();
  for (const w of ws) labels.set(w.id, await walletLabel(db, w));
  const payIds = rows.map((x) => x.r.paymentId).filter(Boolean) as string[];
  const pays = payIds.length
    ? await db
        .select()
        .from(payments)
        .where(inArray(payments.id, payIds.slice(0, 95)))
    : [];

  return rows.map(({ r, requesterName, requesterEmail }) => {
    const p = pays.find((x) => x.id === r.paymentId);
    return {
      id: r.id,
      wallet: { id: r.walletId, label: labels.get(r.walletId) ?? '' },
      parentWalletId: r.parentWalletId,
      to: r.toAdmin ? 'AI Coach (Admin)' : (labels.get(r.parentWalletId) ?? ''),
      toAdmin: r.toAdmin,
      requester: { name: requesterName, email: requesterEmail },
      amountMicro: r.amountMicro,
      message: r.message,
      status: r.status,
      grantedMicro: r.grantedMicro,
      decisionNote: r.decisionNote,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
      payment: p
        ? {
            reference: p.reference,
            method: p.method,
            paidOn: p.paidOn,
            amountMinor: p.amountMinor,
            status: p.status,
          }
        : null,
      can: {
        decide: scope === 'inbox' && r.status === 'pending',
        cancel: r.requestedBy === me.id && r.status === 'pending',
      },
    };
  });
}
