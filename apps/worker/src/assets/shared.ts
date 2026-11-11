import {
  critiqueSchema,
  type AssetCheck,
  type AssetKind,
  type AssetSource,
  type Critique,
  type ExamStrategy,
} from '@aicoach/core';
import { books, examStrategies, learningAssets, type Db } from '@aicoach/db';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { bookTag } from '../content/store';
import type { ZodType } from 'zod';
import { platformWallet } from '../credits/wallets';
import type { Env } from '../env';
import { askJson } from '../llm/json';
import { getTaskConfig } from '../llm/registry';

/** Shared by every kind of learning material (notes, cards): sources, critic verdict, versions. */

export async function textbookTags(db: Db, offeringId: string) {
  const rows = await db
    .select({ id: books.id, version: books.publishedVersion })
    .from(books)
    .where(
      and(
        eq(books.offeringId, offeringId),
        eq(books.kind, 'textbook'),
        isNotNull(books.publishedVersion),
      ),
    );
  return rows.map((r) => bookTag(r.id, r.version!));
}

export const needsFix = (c: Critique) =>
  c.verdict === 'fix' ||
  c.issues.some((i) => i.severity === 'major') ||
  Object.values(c.scores).some((v) => v < 4);

/** "writer model|critic model|prompt version" (decision 9.5-4). */
export async function generatorLabel(db: Db, promptVersion: string) {
  const [writer, critic] = await Promise.all([
    getTaskConfig(db, 'content_generation'),
    getTaskConfig(db, 'content_review'),
  ]);
  return `${writer.primaryModel}|${critic.primaryModel}|${promptVersion}`;
}

export interface SlotRef {
  key: string;
  chapter: number;
  topic: string;
  marks: number;
}

/**
 * Stores an asset as the slot's next draft version. An older unreviewed draft of the slot is
 * superseded; `reject` (a reviewer's "rewrite with my comment") instead marks that draft rejected
 * with the comment, in the same batch.
 */
export async function saveVersion(
  db: Db,
  v: {
    kind: AssetKind;
    promptVersion: string;
    run: { id: string | null; offeringId: string; strategyId: string | null };
    slot: SlotRef;
    content: unknown;
    critique: Critique & { fixedAfter: boolean };
    fixed: boolean;
    checks: AssetCheck[];
    sources: AssetSource[];
    cost: number;
    reject?: { id: string; comment: string; by: string };
  },
) {
  const generator = await generatorLabel(db, v.promptVersion);
  const prev = await db
    .select({ v: sql<number>`coalesce(max(${learningAssets.version}), 0)` })
    .from(learningAssets)
    .where(eq(learningAssets.slotKey, v.slot.key))
    .get();
  const now = new Date();
  const row = { id: crypto.randomUUID() };
  await db.batch([
    v.reject
      ? db
          .update(learningAssets)
          .set({
            status: 'rejected',
            reviewNote: v.reject.comment,
            reviewedBy: v.reject.by,
            reviewedAt: now,
            updatedAt: now,
          })
          .where(and(eq(learningAssets.id, v.reject.id), eq(learningAssets.status, 'draft')))
      : db
          .update(learningAssets)
          .set({ status: 'superseded', updatedAt: now })
          .where(and(eq(learningAssets.slotKey, v.slot.key), eq(learningAssets.status, 'draft'))),
    db.insert(learningAssets).values({
      id: row.id,
      offeringId: v.run.offeringId,
      slotKey: v.slot.key,
      version: Number(prev?.v ?? 0) + 1,
      kind: v.kind,
      chapter: v.slot.chapter,
      topic: v.slot.topic,
      marks: v.slot.marks,
      content: v.content,
      critique: v.critique,
      checks: v.checks,
      sources: v.sources,
      generator,
      fixed: v.fixed,
      strategyId: v.run.strategyId,
      runId: v.run.id,
      costUsdNano: v.cost,
    }),
  ]);
  return row.id;
}

/** The reviewer's comment, given to a fixer as an examiner issue. */
export const reviewerIssue = (comment: string) =>
  JSON.stringify({
    issues: [{ severity: 'major', where: 'reviewer (teacher)', problem: comment, fix: comment }],
  });

interface Prompts<C> {
  writer: { system: string; user: (c: C) => string };
  critic: { system: string; user: (c: C, draft: string) => string };
  fixer: { system: string; user: (c: C, draft: string, issues: string) => string };
}

/**
 * The generation pipeline every kind shares: writer → critic → fixer (only when the critic asks).
 * With `comment` (a reviewer's "rewrite with my comment"): fixer on `from` with the comment →
 * critic on the result (recorded, no further fix).
 */
export async function writeCritiqueFix<C, T>(
  env: Env,
  db: Db,
  o: {
    schema: ZodType<T>;
    prompts: Prompts<C>;
    ctx: C;
    userId: string;
    maxTokens: number;
    rewrite?: { from: unknown; comment: string };
  },
) {
  const payers = [await platformWallet(db)];
  const common = { payers, userId: o.userId, thinking: 'off' as const };
  const write = (system: string, user: string) =>
    askJson(env, db, {
      ...common,
      task: 'content_generation',
      schema: o.schema,
      system,
      user,
      maxTokens: o.maxTokens,
    });
  const critique = (value: T) =>
    askJson(env, db, {
      ...common,
      task: 'content_review',
      schema: critiqueSchema,
      system: o.prompts.critic.system,
      user: o.prompts.critic.user(o.ctx, JSON.stringify(value)),
      maxTokens: 2500,
    });
  if (o.rewrite) {
    const fix = await write(
      o.prompts.fixer.system,
      o.prompts.fixer.user(o.ctx, JSON.stringify(o.rewrite.from), reviewerIssue(o.rewrite.comment)),
    );
    const review = await critique(fix.value);
    return {
      value: fix.value,
      critique: { ...review.value, fixedAfter: false },
      fixed: true,
      cost: fix.costUsdNano + review.costUsdNano,
    };
  }
  const draft = await write(o.prompts.writer.system, o.prompts.writer.user(o.ctx));
  const review = await critique(draft.value);
  let value = draft.value;
  let cost = draft.costUsdNano + review.costUsdNano;
  const fixed = needsFix(review.value);
  if (fixed) {
    const fix = await write(
      o.prompts.fixer.system,
      o.prompts.fixer.user(o.ctx, JSON.stringify(draft.value), JSON.stringify(review.value)),
    );
    value = fix.value;
    cost += fix.costUsdNano;
  }
  return { value, critique: { ...review.value, fixedAfter: fixed }, fixed, cost };
}

/** The strategy an asset follows (for rewrites). */
export async function strategyOf(db: Db, strategyId: string | null) {
  if (!strategyId) throw new Error('This asset has no strategy to follow');
  const strat = await db
    .select()
    .from(examStrategies)
    .where(eq(examStrategies.id, strategyId))
    .get();
  if (!strat?.strategy) throw new Error('The strategy this asset follows has no content');
  return strat.strategy as ExamStrategy;
}
