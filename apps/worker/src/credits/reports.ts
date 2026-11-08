import { allotmentEdits, allotments, llmUsage, user, wallets, type Db } from '@aicoach/db';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { SessionUser } from '../env';
import { available, canManage, isReceiver, walletLabel, type Wallet } from './wallets';

/** Consumption of a wallet and everything below it (path prefix), optionally since a date. */
async function subtreeConsumption(db: Db, path: string, since?: Date) {
  const inSubtree = sql`(${wallets.path} = ${path} OR substr(${wallets.path}, 1, ${path.length + 1}) = ${path + '/'})`;
  const row = await db
    .select({
      billed: sql<number>`coalesce(sum(${llmUsage.billedMicro}), 0)`,
      raw: sql<number>`coalesce(sum(${llmUsage.rawUsdNano}), 0)`,
      calls: sql<number>`count(${llmUsage.id})`,
    })
    .from(llmUsage)
    .innerJoin(wallets, eq(wallets.id, llmUsage.walletId))
    .where(since ? and(inSubtree, sql`${llmUsage.createdAt} >= ${since.getTime()}`) : inSubtree)
    .get();
  return {
    billedMicro: Number(row?.billed ?? 0),
    rawUsdNano: Number(row?.raw ?? 0),
    calls: Number(row?.calls ?? 0),
  };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

export async function walletSummary(db: Db, w: Wallet) {
  const [label, d1, d30, all] = await Promise.all([
    walletLabel(db, w),
    subtreeConsumption(db, w.path, daysAgo(1)),
    subtreeConsumption(db, w.path, daysAgo(30)),
    subtreeConsumption(db, w.path),
  ]);
  return {
    id: w.id,
    ownerType: w.ownerType,
    label,
    parentWalletId: w.parentWalletId,
    balanceMicro: w.balanceMicro,
    heldMicro: w.heldMicro,
    availableMicro: available(w),
    dailyCapMicro: w.dailyCapMicro,
    consumed: {
      last24hMicro: d1.billedMicro,
      last30dMicro: d30.billedMicro,
      totalMicro: all.billedMicro,
      calls: all.calls,
    },
  };
}

export async function walletBreakdown(db: Db, w: Wallet, includeModel: boolean) {
  const inSubtree = sql`(${wallets.path} = ${w.path} OR substr(${wallets.path}, 1, ${w.path.length + 1}) = ${w.path + '/'})`;
  const since = daysAgo(30).getTime();
  const byTask = await db
    .select({
      key: llmUsage.task,
      billed: sql<number>`sum(${llmUsage.billedMicro})`,
      calls: sql<number>`count(*)`,
    })
    .from(llmUsage)
    .innerJoin(wallets, eq(wallets.id, llmUsage.walletId))
    .where(and(inSubtree, sql`${llmUsage.createdAt} >= ${since}`))
    .groupBy(llmUsage.task);
  const byModel = includeModel
    ? await db
        .select({
          key: sql<string>`coalesce(${llmUsage.modelUsed}, ${llmUsage.modelRequested})`,
          billed: sql<number>`sum(${llmUsage.billedMicro})`,
          raw: sql<number>`sum(${llmUsage.rawUsdNano})`,
          calls: sql<number>`count(*)`,
        })
        .from(llmUsage)
        .innerJoin(wallets, eq(wallets.id, llmUsage.walletId))
        .where(and(inSubtree, sql`${llmUsage.createdAt} >= ${since}`))
        .groupBy(sql`coalesce(${llmUsage.modelUsed}, ${llmUsage.modelRequested})`)
    : null;
  return { byTask, byModel };
}

export async function recentUsage(db: Db, w: Wallet, includeModel: boolean) {
  const rows = await db
    .select({
      id: llmUsage.id,
      createdAt: llmUsage.createdAt,
      task: llmUsage.task,
      model: llmUsage.modelUsed,
      status: llmUsage.status,
      billedMicro: llmUsage.billedMicro,
      rawUsdNano: llmUsage.rawUsdNano,
      promptTokens: llmUsage.promptTokens,
      completionTokens: llmUsage.completionTokens,
      cacheStatus: llmUsage.cacheStatus,
      userName: user.name,
    })
    .from(llmUsage)
    .leftJoin(user, eq(user.id, llmUsage.userId))
    .where(eq(llmUsage.walletId, w.id))
    .orderBy(desc(llmUsage.createdAt))
    .limit(30);
  // Raw OpenRouter cost and model are Admin-only (users see billed credits).
  return rows.map((r) => (includeModel ? r : { ...r, model: null, rawUsdNano: null }));
}

export async function walletAllotments(db: Db, viewer: SessionUser, w: Wallet) {
  const rows = await db
    .select()
    .from(allotments)
    .where(or(eq(allotments.toWalletId, w.id), eq(allotments.fromWalletId, w.id)))
    .orderBy(desc(allotments.createdAt))
    .limit(100);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const edits = await db
    .select()
    .from(allotmentEdits)
    .where(inArray(allotmentEdits.allotmentId, ids))
    .orderBy(allotmentEdits.createdAt);
  const walletIds = [
    ...new Set(rows.flatMap((r) => [r.toWalletId, r.fromWalletId].filter(Boolean) as string[])),
  ];
  const ws = await db.select().from(wallets).where(inArray(wallets.id, walletIds));
  const labels = new Map<string, string>();
  for (const x of ws) labels.set(x.id, await walletLabel(db, x));

  const out = [];
  for (const r of rows) {
    const to = ws.find((x) => x.id === r.toWalletId)!;
    const from = r.fromWalletId ? ws.find((x) => x.id === r.fromWalletId)! : null;
    const viewerIsGiver = from ? await canManage(db, viewer, from) : viewer.role === 'admin';
    const viewerIsReceiver = await isReceiver(db, viewer, to);
    out.push({
      id: r.id,
      direction: r.toWalletId === w.id ? ('in' as const) : ('out' as const),
      from: from
        ? { id: from.id, label: labels.get(from.id)! }
        : { id: null, label: 'Admin issuance' },
      to: { id: to.id, label: labels.get(to.id)! },
      amountMicro: r.amountMicro,
      status: r.status,
      note: r.note,
      createdAt: r.createdAt,
      acknowledgedAt: r.acknowledgedAt,
      lockedAt: r.lockedAt,
      paymentId: r.paymentId,
      edits: edits
        .filter((e) => e.allotmentId === r.id)
        .map((e) => ({
          oldAmountMicro: e.oldAmountMicro,
          newAmountMicro: e.newAmountMicro,
          reason: e.reason,
          at: e.createdAt,
        })),
      can: {
        edit: viewerIsGiver && r.status === 'open',
        lock: viewerIsGiver && r.status === 'open' && !!r.acknowledgedAt,
        acknowledge: viewerIsReceiver && r.status === 'open' && !r.acknowledgedAt,
      },
    });
  }
  return out;
}
