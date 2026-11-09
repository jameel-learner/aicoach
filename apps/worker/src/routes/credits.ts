import {
  allotCreditsSchema,
  creditRequestSchema,
  dailyCapSchema,
  decideCreditRequestSchema,
  editAllotmentSchema,
  feeSchema,
  formatInr,
  issueCreditsSchema,
  microToUsdNano,
  parseRateToPaise,
  parseRupeesToMicro,
  recordPaymentSchema,
  usdInrRateSchema,
} from '@aicoach/core';
import {
  allotments,
  classGroups,
  enrolments,
  institutionPocs,
  institutions,
  llmUsage,
  payments,
  user,
  wallets,
  type Db,
} from '@aicoach/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  acknowledgeAllotment,
  allotCredits,
  editAllotment,
  getFeeBps,
  getUsdInrPaise,
  issueCredits,
  lockAllotment,
  setFeeBps,
  setUsdInrPaise,
} from '../credits/ledger';
import {
  cancelCreditRequest,
  createCreditRequest,
  decideCreditRequest,
  listCreditRequests,
  requestTarget,
} from '../credits/requests';
import { recentUsage, walletAllotments, walletBreakdown, walletSummary } from '../credits/reports';
import {
  canManage,
  canView,
  classWallet,
  directUserWallet,
  getWallet,
  institutionWallet,
  isReceiver,
  listChildren,
  platformWallet,
  studentClassWallet,
  walletLabel,
  walletManagers,
  type Wallet,
} from '../credits/wallets';
import type { AppBindings, SessionUser } from '../env';
import { audit } from '../lib/audit';
import { creditsReceivedEmail } from '../lib/emails';
import { badRequest, conflict, forbidden, notFound, parseBody } from '../lib/http';
import type { Notifier } from '../lib/notifier';
import { fetchAccountBalance } from '../llm/openrouter';
import { reconciliationSummary } from '../credits/reconcile';
import { requireAuth, requireRole } from '../middleware/session';

function toMicro(credits: string) {
  try {
    return parseRupeesToMicro(credits);
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : 'Invalid amount');
  }
}

/** Wallets this user owns or manages (the entry points of their Credits page). */
export async function myWallets(db: Db, u: SessionUser): Promise<Wallet[]> {
  const out: Wallet[] = [];
  if (u.role === 'admin') out.push(await platformWallet(db));
  const pocOf = await db
    .select({ id: institutionPocs.institutionId })
    .from(institutionPocs)
    .where(eq(institutionPocs.userId, u.id));
  for (const p of pocOf) out.push(await institutionWallet(db, p.id));
  if (u.role === 'teacher') {
    const classes = await db
      .select({ id: classGroups.id })
      .from(classGroups)
      .where(eq(classGroups.classTeacherId, u.id));
    for (const c of classes) out.push(await classWallet(db, c.id));
  }
  if (u.role === 'student') {
    const classes = await db
      .select({ id: enrolments.classGroupId })
      .from(enrolments)
      .where(
        and(
          eq(enrolments.userId, u.id),
          eq(enrolments.roleIn, 'student'),
          eq(enrolments.status, 'active'),
        ),
      );
    for (const c of classes) if (c.id) out.push(await studentClassWallet(db, u.id, c.id));
  }
  if (u.role === 'student' || u.role === 'teacher') out.push(await directUserWallet(db, u.id));
  return out;
}

async function notifyReceivers(
  db: Db,
  notifier: Notifier,
  appUrl: string,
  to: Wallet,
  amountMicro: number,
  edited = false,
) {
  try {
    const label = await walletLabel(db, to);
    for (const m of await walletManagers(db, to)) {
      await notifier.send(
        creditsReceivedEmail({
          to: m.email,
          name: m.name,
          amount: formatInr(amountMicro),
          walletLabel: label,
          edited,
          appUrl,
        }),
      );
    }
  } catch (err) {
    console.error('credit notification failed', err);
  }
}

export const creditRoutes = new Hono<AppBindings>();
creditRoutes.use('*', requireAuth);

creditRoutes.get('/mine', async (c) => {
  const ws = await myWallets(c.var.db, c.var.user);
  const pending = await Promise.all(
    ws.map(async (w) => {
      const rows = await c.var.db
        .select({ id: allotments.id })
        .from(allotments)
        .where(
          and(
            eq(allotments.toWalletId, w.id),
            eq(allotments.status, 'open'),
            sql`${allotments.acknowledgedAt} IS NULL`,
          ),
        );
      return rows.length;
    }),
  );
  const summaries = await Promise.all(ws.map((w) => walletSummary(c.var.db, w)));
  const targets = await Promise.all(ws.map((w) => requestTarget(c.var.db, w)));
  const receives = await Promise.all(ws.map((w) => isReceiver(c.var.db, c.var.user, w)));
  return c.json(
    summaries.map((s, i) => ({
      ...s,
      pendingAcknowledgements: pending[i],
      // Where "Request credits" goes from this wallet (null: you can't request into it).
      requestTo: receives[i] ? targets[i] : null,
    })),
  );
});

creditRoutes.get('/wallets/:id', async (c) => {
  const { db, user: me } = c.var;
  const w = await getWallet(db, c.req.param('id'));
  if (!(await canView(db, me, w)))
    throw forbidden('You can see your own credits and your immediate downline only');
  const manage = await canManage(db, me, w);
  const isAdmin = me.role === 'admin';
  const [summary, allots, breakdown, usage] = await Promise.all([
    walletSummary(db, w),
    walletAllotments(db, me, w),
    walletBreakdown(db, w, isAdmin),
    manage ? recentUsage(db, w, isAdmin) : Promise.resolve([]),
  ]);
  const children = manage
    ? await Promise.all((await listChildren(db, w)).map((x) => walletSummary(db, x)))
    : [];
  let parent = null;
  if (w.parentWalletId) {
    const p = await getWallet(db, w.parentWalletId);
    if (await canView(db, me, p)) parent = { id: p.id, label: await walletLabel(db, p) };
  }
  return c.json({
    wallet: summary,
    parent,
    children,
    allotments: allots,
    breakdown,
    recentUsage: usage,
    requestTo: (await isReceiver(db, me, w)) ? await requestTarget(db, w) : null,
    can: {
      manage,
      receive: await isReceiver(db, me, w),
      allotToChildren: manage && w.ownerType !== 'user',
      // Admins can drill into any child; others see their immediate downline as a list only.
      drillDown: isAdmin,
    },
  });
});

creditRoutes.post('/allotments', async (c) => {
  const body = await parseBody(c, allotCreditsSchema);
  const from = await getWallet(c.var.db, body.fromWalletId);
  const to = await getWallet(c.var.db, body.toWalletId);
  const amount = toMicro(body.credits);
  const id = await allotCredits(c.var.db, c.var.user, from, to, amount, body.note);
  await notifyReceivers(c.var.db, c.var.notifier, c.env.APP_URL, to, amount);
  return c.json({ id }, 201);
});

creditRoutes.patch('/allotments/:id', async (c) => {
  const body = await parseBody(c, editAllotmentSchema);
  const id = c.req.param('id');
  const amount = toMicro(body.credits);
  await editAllotment(c.var.db, c.var.user, id, amount, body.reason);
  const a = await c.var.db.select().from(allotments).where(eq(allotments.id, id)).get();
  if (a)
    await notifyReceivers(
      c.var.db,
      c.var.notifier,
      c.env.APP_URL,
      await getWallet(c.var.db, a.toWalletId),
      amount,
      true,
    );
  return c.json({ ok: true });
});

creditRoutes.post('/allotments/:id/acknowledge', async (c) => {
  await acknowledgeAllotment(c.var.db, c.var.user, c.req.param('id'));
  return c.json({ ok: true });
});

creditRoutes.post('/allotments/:id/lock', async (c) => {
  await lockAllotment(c.var.db, c.var.user, c.req.param('id'));
  return c.json({ ok: true });
});

/** The giver (manager of the parent wallet) sets a daily spending cap on a child wallet. */
creditRoutes.put('/wallets/:id/daily-cap', async (c) => {
  const { credits } = await parseBody(c, dailyCapSchema);
  const w = await getWallet(c.var.db, c.req.param('id'));
  if (!w.parentWalletId) throw badRequest('The platform wallet has no daily cap');
  if (!(await canManage(c.var.db, c.var.user, await getWallet(c.var.db, w.parentWalletId)))) {
    throw forbidden('Only the giver can set a daily cap');
  }
  const cap = credits === null ? null : toMicro(credits);
  await c.var.db.update(wallets).set({ dailyCapMicro: cap }).where(eq(wallets.id, w.id));
  await audit(c.var.db, c.var.user.id, 'set_daily_cap', 'wallet', w.id, { cap });
  return c.json({ ok: true });
});

/** Ask the level above for credits (decision 9.3-1). Requests to Admin carry the payment UTR. */
creditRoutes.post('/requests', async (c) => {
  const body = await parseBody(c, creditRequestSchema);
  const out = await createCreditRequest(c.var.db, c.var.notifier, c.env.APP_URL, c.var.user, body);
  return c.json(out, 201);
});

/** ?scope=mine (what I asked for) | inbox (asked of me: teacher/POC; Admin: payments to verify). */
creditRoutes.get('/requests', async (c) => {
  const { db, user: me } = c.var;
  const scope = c.req.query('scope') === 'inbox' ? 'inbox' : 'mine';
  let managed: string[] = [];
  if (scope === 'inbox' && me.role !== 'admin') {
    const ws = await myWallets(db, me);
    const flags = await Promise.all(
      ws.map(async (w) => w.ownerType !== 'user' && (await canManage(db, me, w))),
    );
    managed = ws.filter((_, i) => flags[i]).map((w) => w.id);
  }
  return c.json(await listCreditRequests(db, me, scope, managed));
});

creditRoutes.post('/requests/:id/decide', async (c) => {
  const body = await parseBody(c, decideCreditRequestSchema);
  const out = await decideCreditRequest(
    c.var.db,
    c.var.notifier,
    c.env.APP_URL,
    c.var.user,
    c.req.param('id'),
    body,
  );
  return c.json(out);
});

creditRoutes.post('/requests/:id/cancel', async (c) => {
  await cancelCreditRequest(c.var.db, c.var.user, c.req.param('id'));
  return c.json({ ok: true });
});

// =============================================================================================
// Admin: payments, issuance, fee, float
// =============================================================================================

export const adminCreditRoutes = new Hono<AppBindings>();
adminCreditRoutes.use('*', requireAuth, requireRole('admin'));

adminCreditRoutes.get('/payments', async (c) => {
  const rows = await c.var.db
    .select({
      payment: payments,
      institutionName: institutions.name,
      userEmail: user.email,
    })
    .from(payments)
    .leftJoin(institutions, eq(institutions.id, payments.institutionId))
    .leftJoin(user, eq(user.id, payments.userId))
    .orderBy(desc(payments.createdAt))
    .limit(200);
  return c.json(
    rows.map((r) => ({ ...r.payment, institutionName: r.institutionName, userEmail: r.userEmail })),
  );
});

adminCreditRoutes.post('/payments', async (c) => {
  const body = await parseBody(c, recordPaymentSchema);
  const { db } = c.var;
  let userId: string | null = null;
  if (body.payerType === 'user') {
    const u = await db.select().from(user).where(eq(user.email, body.userEmail!)).get();
    if (!u) throw notFound('User with this email');
    userId = u.id;
  }
  if (body.payerType === 'institution') {
    const i = await db
      .select()
      .from(institutions)
      .where(eq(institutions.id, body.institutionId!))
      .get();
    if (!i) throw notFound('Institution');
  }
  const [major, minor = ''] = body.amount.split('.');
  const amountMinor = Number(major) * 100 + Number(minor.padEnd(2, '0'));
  const row = await db
    .insert(payments)
    .values({
      kind: body.kind,
      payerType: body.payerType,
      institutionId: body.payerType === 'institution' ? body.institutionId! : null,
      userId,
      amountMinor,
      currency: body.currency,
      method: body.method,
      reference: body.reference ?? null,
      paidOn: body.paidOn,
      note: body.note ?? null,
      recordedBy: c.var.user.id,
      status: 'verified',
      verifiedBy: c.var.user.id,
      verifiedAt: new Date(),
    })
    .returning()
    .get();
  await audit(db, c.var.user.id, 'record_payment', 'payment', row.id, body);
  return c.json(row, 201);
});

adminCreditRoutes.post('/issue', async (c) => {
  const body = await parseBody(c, issueCreditsSchema);
  const { db } = c.var;
  let to: Wallet;
  if (body.target.type === 'platform') to = await platformWallet(db);
  else if (body.target.type === 'institution') {
    const i = await db
      .select()
      .from(institutions)
      .where(eq(institutions.id, body.target.institutionId))
      .get();
    if (!i) throw notFound('Institution');
    to = await institutionWallet(db, i.id);
  } else {
    const u = await db.select().from(user).where(eq(user.email, body.target.email)).get();
    if (!u) throw notFound('User with this email');
    if (u.role !== 'student' && u.role !== 'teacher')
      throw badRequest('Direct credits are for teachers and students');
    to = await directUserWallet(db, u.id);
  }
  if (body.paymentId) {
    const p = await db.select().from(payments).where(eq(payments.id, body.paymentId)).get();
    if (!p) throw notFound('Payment');
    if (p.kind === 'onboarding_fee') throw badRequest('An onboarding fee does not give credits');
    if (p.status !== 'verified')
      throw conflict(
        'Verify this payment first (Payments to verify), which also issues the credits',
      );
  }
  const amount = toMicro(body.credits);
  const id = await issueCredits(db, c.var.user, to, amount, {
    paymentId: body.paymentId,
    note: body.note,
  });
  if (to.ownerType !== 'platform')
    await notifyReceivers(db, c.var.notifier, c.env.APP_URL, to, amount);
  return c.json({ id, walletId: to.id }, 201);
});

adminCreditRoutes.get('/fee', async (c) =>
  c.json({ feeBps: await getFeeBps(c.var.db), usdInrPaise: await getUsdInrPaise(c.var.db) }),
);
adminCreditRoutes.put('/rate', async (c) => {
  const { rate } = await parseBody(c, usdInrRateSchema);
  const paise = parseRateToPaise(rate);
  await setUsdInrPaise(c.var.db, c.var.user, paise);
  return c.json({ usdInrPaise: paise });
});
adminCreditRoutes.put('/fee', async (c) => {
  const { feeBps } = await parseBody(c, feeSchema);
  await setFeeBps(c.var.db, c.var.user, feeBps);
  return c.json({ feeBps });
});

/**
 * Platform float: can the OpenRouter balance (US$) cover every rupee users still hold?
 * User balances cost balance / rate / (1 + fee) at OpenRouter; the platform wallet costs / rate.
 */
adminCreditRoutes.get('/float', async (c) => {
  const { db } = c.var;
  const [feeBps, usdInrPaise] = await Promise.all([getFeeBps(db), getUsdInrPaise(db)]);
  const sums = await db
    .select({
      outstanding: sql<number>`coalesce(sum(case when ${wallets.ownerType} != 'platform' then ${wallets.balanceMicro} else 0 end), 0)`,
      platform: sql<number>`coalesce(sum(case when ${wallets.ownerType} = 'platform' then ${wallets.balanceMicro} else 0 end), 0)`,
    })
    .from(wallets)
    .get();
  const usage = await db
    .select({
      raw: sql<number>`coalesce(sum(${llmUsage.rawUsdNano}), 0)`,
      billed: sql<number>`coalesce(sum(${llmUsage.billedMicro}), 0)`,
      // Users' cost in rupees at each call's own rate, before the fee.
      userCostMicro: sql<number>`coalesce(sum(case when ${wallets.ownerType} != 'platform' then ${llmUsage.rawUsdNano} * ${llmUsage.usdInrPaise} / 100000.0 else 0 end), 0)`,
      userBilled: sql<number>`coalesce(sum(case when ${wallets.ownerType} != 'platform' then ${llmUsage.billedMicro} else 0 end), 0)`,
    })
    .from(llmUsage)
    .innerJoin(wallets, eq(wallets.id, llmUsage.walletId))
    .get();
  const outstandingMicro = Number(sums?.outstanding ?? 0);
  const platformMicro = Number(sums?.platform ?? 0);
  const requiredUsdNano =
    microToUsdNano(Math.ceil((outstandingMicro * 10_000) / (10_000 + feeBps)), usdInrPaise) +
    microToUsdNano(platformMicro, usdInrPaise);
  let openRouter: { balanceUsdNano: number; totalUsdNano: number; usedUsdNano: number } | null =
    null;
  let openRouterError: string | null = null;
  try {
    const b = await fetchAccountBalance(c.env);
    openRouter = {
      balanceUsdNano: Math.round(b.balanceUsd * 1e9),
      totalUsdNano: Math.round(b.totalUsd * 1e9),
      usedUsdNano: Math.round(b.usedUsd * 1e9),
    };
  } catch (err) {
    openRouterError = err instanceof Error ? err.message : String(err);
  }
  return c.json({
    feeBps,
    usdInrPaise,
    outstandingUserMicro: outstandingMicro,
    platformWalletMicro: platformMicro,
    requiredAtOpenRouterUsdNano: requiredUsdNano,
    openRouter,
    openRouterError,
    shortfallUsdNano: openRouter ? Math.max(0, requiredUsdNano - openRouter.balanceUsdNano) : null,
    warning: openRouter ? openRouter.balanceUsdNano < requiredUsdNano : null,
    reconciliation: await reconciliationSummary(db),
    lifetime: {
      rawUsdNano: Number(usage?.raw ?? 0),
      billedMicro: Number(usage?.billed ?? 0),
      feeRevenueMicro: Math.round(
        Number(usage?.userBilled ?? 0) - Number(usage?.userCostMicro ?? 0),
      ),
    },
  });
});

/** Top-level wallets for the issuance form (institutions + direct users who already have a wallet). */
adminCreditRoutes.get('/top-level', async (c) => {
  const { db } = c.var;
  const platform = await platformWallet(db);
  const children = await listChildren(db, platform);
  const out = [];
  for (const w of [platform, ...children]) out.push(await walletSummary(db, w));
  return c.json(out);
});
