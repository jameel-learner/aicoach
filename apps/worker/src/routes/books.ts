import { bookMetaSchema, mapBookInstitutionsSchema, updateBookPageSchema } from '@aicoach/core';
import {
  bookPages,
  books,
  boards,
  institutionBooks,
  institutions,
  levels,
  subjectOfferings,
  subjects,
  type Db,
} from '@aicoach/db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { PDFDocument } from 'pdf-lib';
import { importBook, listSharedBooks } from '../content/import';
import {
  inlineSteps,
  pageCounts,
  parsePage,
  runIngest,
  type IngestParams,
} from '../content/ingest';
import { pageFlags } from '../content/chunk';
import { contentBucket, keys } from '../content/store';
import type { AppBindings, Env } from '../env';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound, parseBody } from '../lib/http';
import { requireAuth, requireRole } from '../middleware/session';

/**
 * Admin: textbooks (architecture §3.4, §7 Phase 2). Upload → parse → review → publish to the
 * shared content store; import books published elsewhere; map books to institutions (9.2-1).
 */
export const bookRoutes = new Hono<AppBindings>();
bookRoutes.use('*', requireAuth, requireRole('admin'));

const MAX_PDF_BYTES = 60 * 1024 * 1024;

async function getBook(db: Db, id: string) {
  const b = await db.select().from(books).where(eq(books.id, id)).get();
  if (!b) throw notFound('Book');
  return b;
}

/** Starts ingestion in a durable Workflow; tests (no Workflow) run it inline. */
async function startIngest(env: Env, db: Db, params: IngestParams) {
  if (env.APP_ENV === 'test' || !env.INGEST_BOOK) {
    if (env.APP_ENV !== 'test')
      throw badRequest(
        'Textbook processing is not enabled in this environment. Import the book instead.',
      );
    await runIngest(env, db, params, inlineSteps);
    return null;
  }
  const instance = await env.INGEST_BOOK.create({ params });
  await db.update(books).set({ workflowId: instance.id }).where(eq(books.id, params.bookId));
  return instance.id;
}

const offeringLabel = sql<string>`${boards.code} || ' · ' || ${levels.name} || ' · ' || ${subjects.name}`;

bookRoutes.get('/', async (c) => {
  const { db } = c.var;
  const rows = await db
    .select({ book: books, offering: offeringLabel })
    .from(books)
    .innerJoin(subjectOfferings, eq(subjectOfferings.id, books.offeringId))
    .innerJoin(boards, eq(boards.id, subjectOfferings.boardId))
    .innerJoin(levels, eq(levels.id, subjectOfferings.levelId))
    .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
    .orderBy(desc(books.createdAt));
  const counts = await pageCounts(
    db,
    rows.map((r) => r.book.id),
  );
  return c.json(
    rows.map((r) => ({ ...r.book, offering: r.offering, pages: counts.get(r.book.id) ?? {} })),
  );
});

/** Upload a PDF (multipart: file, title, offeringId, edition?, language?). */
bookRoutes.post('/', async (c) => {
  const { db, user: me } = c.var;
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) throw badRequest('Choose a PDF file');
  if (file.size > MAX_PDF_BYTES) throw badRequest('The PDF is larger than 60 MB');
  const meta = bookMetaSchema.safeParse({
    title: form.title,
    offeringId: form.offeringId,
    edition: form.edition || undefined,
    language: form.language || undefined,
  });
  if (!meta.success) throw badRequest(meta.error.issues[0]?.message ?? 'Invalid details');
  const offering = await db
    .select({ id: subjectOfferings.id })
    .from(subjectOfferings)
    .where(eq(subjectOfferings.id, meta.data.offeringId))
    .get();
  if (!offering) throw notFound('Subject offering');

  const bytes = new Uint8Array(await file.arrayBuffer());
  let pageCount: number;
  try {
    pageCount = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
  } catch {
    throw badRequest('That file is not a readable PDF');
  }
  const id = crypto.randomUUID();
  await contentBucket(c.env).put(keys.original(id), bytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { title: meta.data.title, filename: file.name },
  });
  // One atomic batch (no half-created book on failure). Each page row binds 4 parameters, so
  // 20 rows per INSERT stays under D1's 100-parameter limit.
  const PAGE_ROWS = 20;
  const pageInserts = [];
  for (let p = 1; p <= pageCount; p += PAGE_ROWS) {
    const n = Math.min(PAGE_ROWS, pageCount - p + 1);
    pageInserts.push(
      db
        .insert(bookPages)
        .values(Array.from({ length: n }, (_, i) => ({ bookId: id, pageNo: p + i }))),
    );
  }
  await db.batch([
    db.insert(books).values({ id, ...meta.data, pageCount, createdBy: me.id }),
    ...pageInserts,
  ]);
  await audit(db, me.id, 'upload_book', 'book', id, { ...meta.data, pageCount });
  return c.json({ id, pageCount }, 201);
});

bookRoutes.get('/shared', async (c) => c.json(await listSharedBooks(c.env, c.var.db)));

bookRoutes.post('/shared/:bookId/import', async (c) => {
  const out = await importBook(c.env, c.var.db, c.req.param('bookId'), c.var.user.id);
  return c.json(out);
});

bookRoutes.get('/:id', async (c) => {
  const { db } = c.var;
  const book = await getBook(db, c.req.param('id'));
  const pages = await db
    .select({
      pageNo: bookPages.pageNo,
      status: bookPages.status,
      flags: bookPages.flags,
      error: bookPages.error,
      costUsdNano: bookPages.costUsdNano,
      chars: sql<number>`length(coalesce(${bookPages.markdown}, ''))`,
    })
    .from(bookPages)
    .where(eq(bookPages.bookId, book.id))
    .orderBy(asc(bookPages.pageNo));
  const mapped = await db
    .select({ id: institutions.id, name: institutions.name })
    .from(institutionBooks)
    .innerJoin(institutions, eq(institutions.id, institutionBooks.institutionId))
    .where(eq(institutionBooks.bookId, book.id));
  const cost = pages.reduce((s, p) => s + p.costUsdNano, 0);
  return c.json({ book, pages, institutions: mapped, parseCostUsdNano: cost });
});

bookRoutes.post('/:id/parse', async (c) => {
  const { db } = c.var;
  const book = await getBook(db, c.req.param('id'));
  if (book.source === 'imported')
    throw badRequest('Imported books are processed where they were uploaded');
  if (['splitting', 'parsing', 'publishing'].includes(book.status))
    throw conflict('This book is already being processed');
  const workflowId = await startIngest(c.env, db, {
    bookId: book.id,
    phase: 'parse',
    userId: c.var.user.id,
  });
  return c.json({ ok: true, workflowId }, 202);
});

bookRoutes.post('/:id/publish', async (c) => {
  const { db } = c.var;
  const book = await getBook(db, c.req.param('id'));
  if (book.source === 'imported')
    throw badRequest('Imported books are published where they were uploaded');
  if (book.status !== 'review' && book.status !== 'published')
    throw conflict('Parse and review the book before publishing');
  const notReady = await db
    .select({ n: sql<number>`count(*)` })
    .from(bookPages)
    .where(and(eq(bookPages.bookId, book.id), inArray(bookPages.status, ['pending', 'failed'])))
    .get();
  if (Number(notReady?.n ?? 0) > 0)
    throw conflict(`${notReady!.n} page(s) are not parsed yet. Re-parse them first`);
  const workflowId = await startIngest(c.env, db, {
    bookId: book.id,
    phase: 'publish',
    userId: c.var.user.id,
  });
  return c.json({ ok: true, workflowId }, 202);
});

bookRoutes.get('/:id/pages/:pageNo', async (c) => {
  const row = await c.var.db
    .select()
    .from(bookPages)
    .where(
      and(
        eq(bookPages.bookId, c.req.param('id')),
        eq(bookPages.pageNo, Number(c.req.param('pageNo'))),
      ),
    )
    .get();
  if (!row) throw notFound('Page');
  return c.json(row);
});

/** The one-page PDF (for side-by-side review). Falls back to the whole book. */
bookRoutes.get('/:id/pages/:pageNo/pdf', async (c) => {
  const id = c.req.param('id');
  const pageNo = Number(c.req.param('pageNo'));
  const bucket = contentBucket(c.env);
  const obj = (await bucket.get(keys.page(id, pageNo))) ?? (await bucket.get(keys.original(id)));
  if (!obj) throw notFound('PDF');
  return new Response(obj.body, {
    headers: { 'content-type': 'application/pdf', 'cache-control': 'private, max-age=300' },
  });
});

/** Admin review: save corrected Markdown and/or approve the page. */
bookRoutes.put('/:id/pages/:pageNo', async (c) => {
  const { db, user: me } = c.var;
  const body = await parseBody(c, updateBookPageSchema);
  const id = c.req.param('id');
  const pageNo = Number(c.req.param('pageNo'));
  const book = await getBook(db, id);
  if (book.source === 'imported') throw badRequest('Edit imported books where they were uploaded');
  const row = await db
    .select()
    .from(bookPages)
    .where(and(eq(bookPages.bookId, id), eq(bookPages.pageNo, pageNo)))
    .get();
  if (!row) throw notFound('Page');
  const markdown = body.markdown ?? row.markdown ?? '';
  await db
    .update(bookPages)
    .set({
      markdown,
      flags: pageFlags(markdown),
      status: body.markdown !== undefined && body.markdown !== row.markdown ? 'edited' : 'approved',
      error: null,
      updatedBy: me.id,
      updatedAt: new Date(),
    })
    .where(and(eq(bookPages.bookId, id), eq(bookPages.pageNo, pageNo)));
  await audit(db, me.id, 'review_book_page', 'book', id, {
    pageNo,
    edited: body.markdown !== undefined,
  });
  return c.json({ ok: true });
});

/** Re-parse one page now (e.g. a failed or poor page). */
bookRoutes.post('/:id/pages/:pageNo/reparse', async (c) => {
  const { db } = c.var;
  const book = await getBook(db, c.req.param('id'));
  if (book.source === 'imported')
    throw badRequest('Imported books are processed where they were uploaded');
  await parsePage(c.env, db, book.id, Number(c.req.param('pageNo')), c.var.user.id, true);
  return c.json({ ok: true });
});

/** Which institutions use this book (decision 9.2-1, set once at onboarding). */
bookRoutes.put('/:id/institutions', async (c) => {
  const { db, user: me } = c.var;
  const { institutionIds } = await parseBody(c, mapBookInstitutionsSchema);
  const book = await getBook(db, c.req.param('id'));
  if (!book.publishedVersion) throw conflict('Publish (or import) the book before assigning it');
  const ids = [...new Set(institutionIds)].slice(0, 90);
  if (ids.length) {
    const found = await db
      .select({ id: institutions.id })
      .from(institutions)
      .where(inArray(institutions.id, ids));
    if (found.length !== ids.length) throw notFound('Institution');
  }
  await db.delete(institutionBooks).where(eq(institutionBooks.bookId, book.id));
  for (const institutionId of ids)
    await db.insert(institutionBooks).values({ institutionId, bookId: book.id, mappedBy: me.id });
  await audit(db, me.id, 'map_book_institutions', 'book', book.id, { institutionIds: ids });
  return c.json({ ok: true });
});
