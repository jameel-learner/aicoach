import type { AssetSource } from '@aicoach/core';
import { books, examStrategies, learningAssets, subjectOfferings, type Db } from '@aicoach/db';
import { and, eq, inArray, max, ne, sql } from 'drizzle-orm';
import { contentBucket } from '../content/store';
import type { Env } from '../env';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/http';
import { approvedStrategy } from './generate';

/**
 * Moving reviewed learning material between environments (architecture §3.3, decision 9.5-7):
 * LOCAL publishes the approved exam strategy + every APPROVED asset of a subject as a versioned
 * package in the shared content store (add-only: a new `vN` file per publish, never overwritten);
 * another environment imports it, without any model call. Drafts, rejected versions, teacher
 * reviews, reviewer accounts, costs and past-paper questions (`board_items`) stay where they are.
 */

export const materialKeys = {
  pkg: (offeringId: string, version: number) => `material/${offeringId}/v${version}.json`,
  /** The latest package of a subject (small): what "Import" shows. */
  catalog: (offeringId: string) => `material/catalog/${offeringId}.json`,
};

export const PACKAGE_FORMAT = 1;

export interface PackagedAsset {
  id: string;
  slotKey: string;
  version: number;
  kind: 'note' | 'cards' | 'questions' | 'graph';
  chapter: number;
  topic: string;
  marks: number;
  content: unknown;
  critique: unknown;
  checks: unknown[];
  sources: unknown[];
  generator: string;
  fixed: boolean;
  strategyId: string | null;
}

export interface MaterialCatalog {
  format: number;
  offeringId: string;
  version: number;
  publishedAt: string;
  publishedFrom: string;
  strategy: { id: string; version: number; promptVersion: string };
  /** Textbooks the assets cite, with the version they were generated from. */
  books: { bookId: string; title: string; version: string | null }[];
  counts: Record<PackagedAsset['kind'], number>;
  chapters: number[];
  generators: string[];
}

export interface MaterialPackage extends MaterialCatalog {
  strategyRow: {
    id: string;
    version: number;
    promptVersion: string;
    strategy: unknown;
    sourceBookIds: string[];
  };
  assets: PackagedAsset[];
}

async function readCatalog(env: Env, offeringId: string) {
  const obj = await contentBucket(env).get(materialKeys.catalog(offeringId));
  return obj ? ((await obj.json()) as MaterialCatalog) : null;
}

/** Publish the subject's approved strategy and approved material as the next package version. */
export async function publishMaterial(env: Env, db: Db, offeringId: string, actorId: string) {
  const bucket = contentBucket(env);
  const strat = await approvedStrategy(db, offeringId);
  if (!strat) throw badRequest('Approve an exam strategy for this subject first');
  const rows = await db
    .select()
    .from(learningAssets)
    .where(and(eq(learningAssets.offeringId, offeringId), eq(learningAssets.status, 'approved')));
  if (!rows.length) throw badRequest('Nothing approved to publish yet');

  const bookIds = [
    ...new Set(rows.flatMap((r) => (r.sources as AssetSource[]).map((s) => s.bookId))),
  ];
  const bookRows = bookIds.length
    ? await db
        .select({ id: books.id, title: books.title, version: books.publishedVersion })
        .from(books)
        .where(inArray(books.id, bookIds.slice(0, 90)))
    : [];

  // Next version: never overwrite a package that is already in the add-only store.
  let version = ((await readCatalog(env, offeringId))?.version ?? 0) + 1;
  while (await bucket.head(materialKeys.pkg(offeringId, version))) version++;

  const counts = { note: 0, cards: 0, questions: 0, graph: 0 };
  for (const r of rows) counts[r.kind]++;
  const catalog: MaterialCatalog = {
    format: PACKAGE_FORMAT,
    offeringId,
    version,
    publishedAt: new Date().toISOString(),
    publishedFrom: env.APP_ENV,
    strategy: { id: strat.id, version: strat.version, promptVersion: strat.promptVersion },
    books: bookIds.map((id) => {
      const b = bookRows.find((x) => x.id === id);
      return { bookId: id, title: b?.title ?? id, version: b?.version ?? null };
    }),
    counts,
    chapters: [...new Set(rows.map((r) => r.chapter).filter((c) => c > 0))].sort((a, b) => a - b),
    generators: [...new Set(rows.map((r) => r.generator))],
  };
  const pkg: MaterialPackage = {
    ...catalog,
    strategyRow: {
      id: strat.id,
      version: strat.version,
      promptVersion: strat.promptVersion,
      strategy: strat.strategy,
      sourceBookIds: strat.sourceBookIds,
    },
    assets: rows
      .sort((a, b) => a.slotKey.localeCompare(b.slotKey))
      .map((r) => ({
        id: r.id,
        slotKey: r.slotKey,
        version: r.version,
        kind: r.kind,
        chapter: r.chapter,
        topic: r.topic,
        marks: r.marks,
        content: r.content,
        critique: r.critique ?? null,
        checks: r.checks,
        sources: r.sources,
        generator: r.generator,
        fixed: r.fixed,
        strategyId: r.strategyId,
      })),
  };
  await bucket.put(materialKeys.pkg(offeringId, version), JSON.stringify(pkg), {
    httpMetadata: { contentType: 'application/json' },
  });
  await bucket.put(materialKeys.catalog(offeringId), JSON.stringify(catalog), {
    httpMetadata: { contentType: 'application/json' },
  });
  await audit(db, actorId, 'publish_material', 'subject_offering', offeringId, {
    version,
    counts,
  });
  return catalog;
}

/** The subject's latest package in the shared store and how much of it this environment has. */
export async function sharedMaterial(env: Env, db: Db, offeringId: string) {
  const cat = await readCatalog(env, offeringId);
  if (!cat) return null;
  const obj = await contentBucket(env).get(materialKeys.pkg(offeringId, cat.version));
  if (!obj) return { ...cat, here: 0, total: 0, upToDate: false };
  const pkg = (await obj.json()) as MaterialPackage;
  const ids = pkg.assets.map((a) => a.id);
  let here = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const r = await db
      .select({ n: sql<number>`count(*)` })
      .from(learningAssets)
      .where(
        and(
          inArray(learningAssets.id, ids.slice(i, i + 90)),
          eq(learningAssets.status, 'approved'),
        ),
      )
      .get();
    here += Number(r?.n ?? 0);
  }
  return { ...cat, here, total: ids.length, upToDate: here === ids.length };
}

/**
 * Import the subject's latest package into this environment's D1. Safe to repeat: versions already
 * here are skipped; a newer version replaces the slot's approved one. Refuses when a textbook the
 * material cites has not been imported here (citations would point nowhere).
 */
export async function importMaterial(env: Env, db: Db, offeringId: string, actorId: string) {
  const cat = await readCatalog(env, offeringId);
  if (!cat) throw notFound('Published material for this subject in the shared content store');
  const obj = await contentBucket(env).get(materialKeys.pkg(offeringId, cat.version));
  if (!obj) throw notFound(`Material package v${cat.version}`);
  const pkg = (await obj.json()) as MaterialPackage;
  if (pkg.format !== PACKAGE_FORMAT) throw badRequest(`Unknown package format ${pkg.format}`);

  const offering = await db
    .select({ id: subjectOfferings.id })
    .from(subjectOfferings)
    .where(eq(subjectOfferings.id, offeringId))
    .get();
  if (!offering) throw badRequest(`This environment has no subject offering ${offeringId}`);

  const bookIds = pkg.books.map((b) => b.bookId);
  const here = bookIds.length
    ? await db
        .select({ id: books.id, status: books.status, version: books.publishedVersion })
        .from(books)
        .where(inArray(books.id, bookIds.slice(0, 90)))
    : [];
  const missing = pkg.books.filter(
    (b) => here.find((h) => h.id === b.bookId)?.status !== 'published',
  );
  if (missing.length)
    throw badRequest(
      `Import ${missing.map((b) => `${b.title} ${b.version ?? ''}`.trim()).join(', ')} first (Books → Import): the material cites ${missing.length === 1 ? 'it' : 'them'}.`,
    );
  const warnings = pkg.books
    .filter((b) => b.version && here.find((h) => h.id === b.bookId)?.version !== b.version)
    .map(
      (b) =>
        `${b.title}: material made from ${b.version}, this environment has ${here.find((h) => h.id === b.bookId)?.version}`,
    );

  const now = new Date();
  const note = `Imported from the shared store (package v${pkg.version})`;

  // 1. The strategy (same id as where it was compiled).
  const s = pkg.strategyRow;
  const existing = await db
    .select({ id: examStrategies.id })
    .from(examStrategies)
    .where(eq(examStrategies.id, s.id))
    .get();
  let strategyImported = false;
  if (!existing) {
    const top = await db
      .select({ v: max(examStrategies.version) })
      .from(examStrategies)
      .where(eq(examStrategies.offeringId, offeringId))
      .get();
    const taken = await db
      .select({ id: examStrategies.id })
      .from(examStrategies)
      .where(and(eq(examStrategies.offeringId, offeringId), eq(examStrategies.version, s.version)))
      .get();
    await db.batch([
      db
        .update(examStrategies)
        .set({ status: 'superseded', updatedAt: now })
        .where(
          and(eq(examStrategies.offeringId, offeringId), eq(examStrategies.status, 'approved')),
        ),
      db.insert(examStrategies).values({
        id: s.id,
        offeringId,
        version: taken ? (top?.v ?? 0) + 1 : s.version,
        status: 'approved',
        strategy: s.strategy,
        sourceBookIds: s.sourceBookIds,
        promptVersion: s.promptVersion,
        reviewNote: note,
        createdBy: actorId,
        approvedBy: actorId,
        approvedAt: now,
      }),
    ]);
    strategyImported = true;
  }

  // 2. The approved assets, slot by slot.
  const ids = pkg.assets.map((a) => a.id);
  const have = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const r = await db
      .select({ id: learningAssets.id })
      .from(learningAssets)
      .where(inArray(learningAssets.id, ids.slice(i, i + 90)));
    for (const x of r) have.add(x.id);
  }
  const todo = pkg.assets.filter((a) => !have.has(a.id));
  const strategyIds = new Set([s.id]);
  let imported = 0;
  for (let i = 0; i < todo.length; i += 20) {
    const batch = todo.slice(i, i + 20);
    const current = await db
      .select({ slotKey: learningAssets.slotKey, version: learningAssets.version })
      .from(learningAssets)
      .where(
        inArray(
          learningAssets.slotKey,
          batch.map((a) => a.slotKey),
        ),
      );
    // A slot version made here under another id (should not happen: only LOCAL generates).
    const part = batch.filter(
      (a) => !current.some((c) => c.slotKey === a.slotKey && c.version === a.version),
    );
    if (!part.length) continue;
    const stmts = part.flatMap((a) => {
      const top = Math.max(
        0,
        ...current.filter((c) => c.slotKey === a.slotKey).map((c) => c.version),
      );
      if (top > a.version) {
        // This environment already has a newer version of the slot: keep it, store this as history.
        return [insertAsset(db, a, offeringId, 'superseded', actorId, now, note, strategyIds)];
      }
      return [
        db
          .update(learningAssets)
          .set({ status: 'superseded', updatedAt: now })
          .where(
            and(
              eq(learningAssets.slotKey, a.slotKey),
              eq(learningAssets.status, 'approved'),
              ne(learningAssets.id, a.id),
            ),
          ),
        insertAsset(db, a, offeringId, 'approved', actorId, now, note, strategyIds),
      ];
    });
    await db.batch(stmts as unknown as Parameters<Db['batch']>[0]);
    imported += part.length;
  }
  const result = {
    version: pkg.version,
    strategy: strategyImported ? 'imported' : 'already here',
    imported,
    skipped: pkg.assets.length - imported,
    warnings,
  };
  await audit(db, actorId, 'import_material', 'subject_offering', offeringId, result);
  return result;
}

function insertAsset(
  db: Db,
  a: PackagedAsset,
  offeringId: string,
  status: 'approved' | 'superseded',
  actorId: string,
  now: Date,
  note: string,
  strategyIds: Set<string>,
) {
  return db.insert(learningAssets).values({
    id: a.id,
    offeringId,
    slotKey: a.slotKey,
    version: a.version,
    kind: a.kind,
    chapter: a.chapter,
    topic: a.topic,
    marks: a.marks,
    status,
    content: a.content,
    critique: a.critique,
    checks: a.checks,
    sources: a.sources,
    generator: a.generator,
    fixed: a.fixed,
    // Only the packaged strategy is guaranteed to exist here (foreign key).
    strategyId: a.strategyId && strategyIds.has(a.strategyId) ? a.strategyId : null,
    runId: null,
    costUsdNano: 0,
    reviewNote: note,
    reviewedBy: actorId,
    reviewedAt: now,
  });
}
