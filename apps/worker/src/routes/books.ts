import {
  bookMetaSchema,
  mapBookInstitutionsSchema,
  parsePageList,
  removedReasonsSchema,
  setRemovedReasonsSchema,
  updateBookPageSchema,
} from '@aicoach/core';
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

/** Every page a reason names must be one that was removed (original page numbers). */
function checkReasons(reasons: { pages: string }[], removed: number[]) {
  const max = Math.max(0, ...removed) + 1;
  for (const r of reasons) {
    const list = parsePageList(r.pages, max);
    if (typeof list === 'string') throw badRequest(`Reason pages "${r.pages}": ${list}`);
    const extra = list.filter((p) => !removed.includes(p));
    if (extra.length)
      throw badRequest(`Reason pages "${r.pages}" include page ${extra[0]}, which was not removed`);
  }
}

async function getBook(db: Db, id: string) {
  const b = await db.select().from(books).where(eq(books.id, id)).get();
  if (!b) throw notFound('Book');
  return b;
}

/**
 * Books are processed only where the ingestion Workflow is bound (LOCAL; tests run it inline).
 * Elsewhere (staging) uploads are refused too, so no unprocessable PDF lands in the shared,
 * add-only content store; books are imported from that store instead.
 */
export const processingEnabled = (env: Pick<Env, 'APP_ENV' | 'INGEST_BOOK'>) =>
  env.APP_ENV === 'test' || !!env.INGEST_BOOK;
export const PROCESS_ON_LOCAL = 'Process books on local, then import them here.';

const BUSY: string[] = ['splitting', 'parsing', 'publishing'];
/** No progress for this long while "busy" = the run died (e.g. the local dev server reloaded). */
export const STALL_MS = 10 * 60_000;

/**
 * A busy book whose last progress (book or any page row) is older than STALL_MS. Such a run can be
 * started again: reading skips pages already done, publishing rewrites its unfinished version.
 */
export async function isStalled(db: Db, book: typeof books.$inferSelect, now = Date.now()) {
  if (!BUSY.includes(book.status)) return false;
  const last = await db
    .select({ t: sql<number | null>`max(${bookPages.updatedAt})` })
    .from(bookPages)
    .where(eq(bookPages.bookId, book.id))
    .get();
  const lastMs = Math.max(book.updatedAt.getTime(), Number(last?.t ?? 0));
  return now - lastMs > STALL_MS;
}

/** Starts ingestion in a durable Workflow; tests (no Workflow) run it inline. */
async function startIngest(env: Env, db: Db, params: IngestParams) {
  if (env.APP_ENV === 'test' || !env.INGEST_BOOK) {
    if (env.APP_ENV !== 'test')
      throw badRequest(
        `Textbook processing is not enabled in this environment. ${PROCESS_ON_LOCAL}`,
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

/** What this environment can do (the web page hides the upload form where it can't process). */
bookRoutes.get('/settings', (c) => c.json({ processingEnabled: processingEnabled(c.env) }));

/** Upload a PDF (multipart: file, title, offeringId, edition?, language?). */
bookRoutes.post('/', async (c) => {
  const { db, user: me } = c.var;
  if (!processingEnabled(c.env)) throw badRequest(PROCESS_ON_LOCAL);
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) throw badRequest('Choose a PDF file');
  if (file.size > MAX_PDF_BYTES) throw badRequest('The PDF is larger than 60 MB');
  const meta = bookMetaSchema.safeParse({
    title: form.title,
    offeringId: form.offeringId,
    edition: form.edition || undefined,
    language: form.language || undefined,
    kind: form.kind || undefined,
    category: form.category || undefined,
    academicYear: form.academicYear || undefined,
    relatedBookId: form.relatedBookId || undefined,
  });
  if (!meta.success) throw badRequest(meta.error.issues[0]?.message ?? 'Invalid details');
  const board = meta.data.kind === 'board_material';
  if (board && (!meta.data.category || !meta.data.academicYear))
    throw badRequest('Board material needs a category and an academic year');
  if (!board && (meta.data.category || meta.data.relatedBookId))
    throw badRequest('Category and linked paper are for board material only');
  if (meta.data.relatedBookId) {
    const paper = await db
      .select({ kind: books.kind })
      .from(books)
      .where(eq(books.id, meta.data.relatedBookId))
      .get();
    if (paper?.kind !== 'board_material') throw notFound('Linked paper');
  }
  const offering = await db
    .select({ id: subjectOfferings.id })
    .from(subjectOfferings)
    .where(eq(subjectOfferings.id, meta.data.offeringId))
    .get();
  if (!offering) throw notFound('Subject offering');

  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    throw badRequest('That file is not a readable PDF');
  }
  // Pages removed BEFORE storing (e.g. answer-script cover pages with a register number): they
  // never reach the shared, add-only content store (decision 9.5-2).
  let removedPages: number[] | null = null;
  const removeText = typeof form.removePages === 'string' ? form.removePages.trim() : '';
  if (removeText) {
    const list = parsePageList(removeText, pdf.getPageCount());
    if (typeof list === 'string') throw badRequest(list);
    for (const p of [...list].reverse()) pdf.removePage(p - 1);
    bytes = await pdf.save();
    removedPages = list;
  }
  let removedReasons: { pages: string; why: string }[] | null = null;
  if (typeof form.removeReasons === 'string' && form.removeReasons.trim()) {
    let raw: unknown;
    try {
      raw = JSON.parse(form.removeReasons);
    } catch {
      throw badRequest('removeReasons must be JSON');
    }
    const parsed = removedReasonsSchema.safeParse(raw);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid reasons');
    checkReasons(parsed.data, removedPages ?? []);
    removedReasons = parsed.data;
  }
  const pageCount = pdf.getPageCount();
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
    db
      .insert(books)
      .values({ id, ...meta.data, pageCount, removedPages, removedReasons, createdBy: me.id }),
    ...pageInserts,
  ]);
  await audit(db, me.id, 'upload_book', 'book', id, { ...meta.data, pageCount, removedPages });
  return c.json({ id, pageCount }, 201);
});

/**
 * Why pages were left out (for documents uploaded before reasons were recorded). Only describes
 * pages that were actually removed; changes nothing in the stored PDF.
 */
bookRoutes.put('/:id/removed-reasons', async (c) => {
  const { db } = c.var;
  const book = await getBook(db, c.req.param('id'));
  const { reasons } = await parseBody(c, setRemovedReasonsSchema);
  checkReasons(reasons, book.removedPages ?? []);
  await db
    .update(books)
    .set({ removedReasons: reasons, updatedAt: new Date() })
    .where(eq(books.id, book.id));
  // Already published here: add the reasons to its catalog entry, so other environments import
  // them (the catalog entry is the "latest" pointer that every publish rewrites; nothing is deleted).
  if (book.publishedVersion && book.source === 'ingested') {
    const bucket = contentBucket(c.env);
    const cat = await bucket.get(keys.catalog(book.id));
    if (cat) {
      const manifest = (await cat.json()) as Record<string, unknown>;
      await bucket.put(
        keys.catalog(book.id),
        JSON.stringify({ ...manifest, removedReasons: reasons }),
      );
    }
  }
  await audit(db, c.var.user.id, 'set_removed_reasons', 'book', book.id, { reasons });
  return c.json({ ok: true });
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
  return c.json({
    book,
    pages,
    institutions: mapped,
    parseCostUsdNano: cost,
    stalled: await isStalled(db, book),
  });
});

bookRoutes.post('/:id/parse', async (c) => {
  const { db } = c.var;
  const book = await getBook(db, c.req.param('id'));
  if (book.source === 'imported')
    throw badRequest('Imported books are processed where they were uploaded');
  if (BUSY.includes(book.status) && !(await isStalled(db, book)))
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
  const stalledPublish = book.status === 'publishing' && (await isStalled(db, book));
  if (book.status !== 'review' && book.status !== 'published' && !stalledPublish)
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
