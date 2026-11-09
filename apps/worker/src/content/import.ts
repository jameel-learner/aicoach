import { bookPages, books, subjectOfferings, type Db } from '@aicoach/db';
import { eq, inArray } from 'drizzle-orm';
import type { Env } from '../env';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/http';
import type { Chunk } from './chunk';
import { parseJsonl, writeChunksToD1, type Manifest } from './ingest';
import { contentBucket, keys } from './store';

/**
 * Importing a published book from the SHARED content store into this environment's D1
 * (decision 9.4-1): no re-parsing, no re-embedding (the vectors are already in Vectorize).
 */

/** Published books in the shared store, with whether/which version this environment has. */
export async function listSharedBooks(env: Env, db: Db) {
  const bucket = contentBucket(env);
  const manifests: Manifest[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: keys.catalogPrefix, cursor });
    for (const o of page.objects) {
      const obj = await bucket.get(o.key);
      if (obj) manifests.push((await obj.json()) as Manifest);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const ids = manifests.map((m) => m.bookId);
  const local = ids.length
    ? await db
        .select({ id: books.id, publishedVersion: books.publishedVersion, source: books.source })
        .from(books)
        .where(inArray(books.id, ids.slice(0, 90)))
    : [];
  return manifests
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((m) => {
      const here = local.find((l) => l.id === m.bookId);
      return {
        ...m,
        localVersion: here?.publishedVersion ?? null,
        upToDate: here?.publishedVersion === m.version,
      };
    });
}

export async function importBook(env: Env, db: Db, bookId: string, actorId: string) {
  const bucket = contentBucket(env);
  const cat = await bucket.get(keys.catalog(bookId));
  if (!cat) throw notFound('Published book in the shared content store');
  const m = (await cat.json()) as Manifest;
  const offering = await db
    .select({ id: subjectOfferings.id })
    .from(subjectOfferings)
    .where(eq(subjectOfferings.id, m.offeringId))
    .get();
  if (!offering) throw badRequest(`This environment has no subject offering ${m.offeringId}`);

  const [pagesObj, chunksObj] = await Promise.all([
    bucket.get(keys.pkg(bookId, m.version, 'pages.jsonl')),
    bucket.get(keys.pkg(bookId, m.version, 'chunks.jsonl')),
  ]);
  if (!pagesObj || !chunksObj) throw notFound(`Package files for ${m.title} ${m.version}`);
  const pages = parseJsonl<{ page: number; markdown: string }>(await pagesObj.text());
  const rows = parseJsonl<Chunk & { id: string }>(await chunksObj.text());

  const existing = await db.select().from(books).where(eq(books.id, bookId)).get();
  const versionNo = Number(m.version.replace(/^v/, ''));
  const values = {
    title: m.title,
    offeringId: m.offeringId,
    edition: m.edition,
    language: m.language,
    pageCount: m.pageCount,
    status: 'published' as const,
    statusMessage: null,
    publishedVersion: m.version,
    nextVersion: Math.max(existing?.nextVersion ?? 1, versionNo + 1),
    updatedAt: new Date(),
  };
  if (existing) await db.update(books).set(values).where(eq(books.id, bookId));
  else
    await db
      .insert(books)
      .values({ id: bookId, ...values, source: 'imported', createdBy: actorId });

  // Pages (for the review screen / citations), then chunks + FTS.
  await db.delete(bookPages).where(eq(bookPages.bookId, bookId));
  for (let i = 0; i < pages.length; i += 40) {
    await db.batch(
      pages.slice(i, i + 40).map((pg) =>
        db.insert(bookPages).values({
          bookId,
          pageNo: pg.page,
          markdown: pg.markdown,
          status: 'approved',
          updatedBy: actorId,
        }),
      ) as unknown as Parameters<Db['batch']>[0],
    );
  }
  await writeChunksToD1(db, bookId, m.version, rows);
  await audit(db, actorId, 'import_book', 'book', bookId, {
    version: m.version,
    chunks: rows.length,
  });
  return { bookId, version: m.version, pages: pages.length, chunks: rows.length };
}
