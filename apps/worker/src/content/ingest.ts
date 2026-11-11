import { bookPages, books, type Db } from '@aicoach/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { InsufficientCredits } from '../credits/ledger';
import { platformWallet } from '../credits/wallets';
import type { Env } from '../env';
import { runMeteredChat } from '../llm/run';
import { chunkPages, pageFlags, type Chunk } from './chunk';
import { bookTag, contentBucket, embedder, keys, vectorStore } from './store';

/**
 * Textbook ingestion (architecture §3.4). Runs where the Admin uploads (normally LOCAL) and writes
 * to the SHARED content store; other environments import the published package (import.ts).
 *
 *   parse:   split the PDF into one-page PDFs (R2) → parse each page via OpenRouter file-parser
 *            (mistral-ocr; charged to the platform wallet) → per-page Markdown + quality flags
 *   review:  Admin checks/edits pages (routes/books.ts)
 *   publish: chunk → embed (Workers AI bge-m3) → Vectorize → R2 package + catalog → this D1 + FTS
 *
 * Written as named steps so it runs in a Cloudflare Workflow (durable, resumable) and inline in tests.
 */

export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}
/** Runs steps immediately (tests, and the single-page re-parse). */
export const inlineSteps: StepRunner = { do: (_name, fn) => fn() };

export interface IngestParams {
  bookId: string;
  phase: 'parse' | 'publish';
  userId: string;
}

const PDF_ENGINE = 'mistral-ocr';
const OCR_ESTIMATE_USD_NANO = 3_000_000; // ~$0.002/page OCR fee + margin, held before each call
const SPLIT_BATCH = 25;
const PARSE_BATCH = 5; // pages parsed in parallel per step
const EMBED_BATCH = 100;

type Book = typeof books.$inferSelect;

async function loadBook(db: Db, bookId: string): Promise<Book> {
  const b = await db.select().from(books).where(eq(books.id, bookId)).get();
  if (!b) throw new Error(`Book ${bookId} not found`);
  return b;
}

const setStatus = (db: Db, bookId: string, status: Book['status'], message: string | null = null) =>
  db
    .update(books)
    .set({ status, statusMessage: message, updatedAt: new Date() })
    .where(eq(books.id, bookId));

// ---------------------------------------------------------------- split

/** Writes one-page PDFs for pages [from, to] to R2 (skips pages already there). */
export async function splitPages(env: Env, bookId: string, from: number, to: number) {
  const bucket = contentBucket(env);
  const original = await bucket.get(keys.original(bookId));
  if (!original) throw new Error('The uploaded PDF is missing from the content store');
  const src = await PDFDocument.load(await original.arrayBuffer(), { ignoreEncryption: true });
  for (let p = from; p <= to; p++) {
    if (await bucket.head(keys.page(bookId, p))) continue;
    const one = await PDFDocument.create();
    const [page] = await one.copyPages(src, [p - 1]);
    one.addPage(page!);
    await bucket.put(keys.page(bookId, p), await one.save(), {
      httpMetadata: { contentType: 'application/pdf' },
    });
  }
}

// ---------------------------------------------------------------- parse

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Parses one page (idempotent: pages already parsed/approved/edited are skipped unless `force`).
 * Failures are recorded on the page; only "not enough credits" is thrown (stop the whole run).
 */
export async function parsePage(
  env: Env,
  db: Db,
  bookId: string,
  pageNo: number,
  userId: string,
  force = false,
) {
  const row = await db
    .select({ status: bookPages.status })
    .from(bookPages)
    .where(and(eq(bookPages.bookId, bookId), eq(bookPages.pageNo, pageNo)))
    .get();
  if (!force && row && row.status !== 'pending' && row.status !== 'failed') return;

  const obj = await contentBucket(env).get(keys.page(bookId, pageNo));
  if (!obj) throw new Error(`Page ${pageNo} PDF is missing; run the split step first`);
  const pdf = new Uint8Array(await obj.arrayBuffer());
  const book = await db
    .select({ category: books.category })
    .from(books)
    .where(eq(books.id, bookId))
    .get();
  try {
    if (book?.category === 'answer_script') {
      // Handwritten, often photographed sideways: OCR engines do poorly, a vision model reads it.
      const t = await transcribeHandwriting(env, db, pdf, pageNo, userId);
      await savePage(db, bookId, pageNo, userId, t.text, t.rawUsdNano);
      return;
    }
    const res = await runMeteredChat(env, db, {
      task: 'pdf_parse',
      payers: [await platformWallet(db)],
      userId,
      maxTokens: 5, // we only need the parser's output (annotations), not a model answer
      plugins: [{ id: 'file-parser', pdf: { engine: PDF_ENGINE } }],
      extraEstimateUsdNano: OCR_ESTIMATE_USD_NANO,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Reply with OK.' },
            {
              type: 'file',
              file: {
                filename: `page-${pageNo}.pdf`,
                file_data: `data:application/pdf;base64,${toBase64(pdf)}`,
              },
            },
          ],
        },
      ],
    });
    let markdown = res.fileText ?? '';
    let cost = res.rawUsdNano;
    if (IMAGE_REF.test(markdown)) {
      // The page has figures: describe them so diagrams become searchable, citable text.
      const fig = await describeFigures(env, db, pdf, pageNo, userId);
      markdown = withFigureDescriptions(markdown, fig.text);
      cost += fig.rawUsdNano;
    }
    await savePage(db, bookId, pageNo, userId, markdown, cost);
  } catch (err) {
    if (err instanceof InsufficientCredits) throw err;
    await db
      .update(bookPages)
      .set({
        status: 'failed',
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        updatedAt: new Date(),
      })
      .where(and(eq(bookPages.bookId, bookId), eq(bookPages.pageNo, pageNo)));
  }
}

/** OCR/vision text can carry absurd table dividers (thousands of dashes): keep them short. */
export const tidy = (md: string) =>
  md
    .replace(/-{6,}/g, '---')
    .replace(/:-{3,}/g, ':---')
    .replace(/[ \t]{4,}/g, '  ');

async function savePage(
  db: Db,
  bookId: string,
  pageNo: number,
  userId: string,
  markdown: string,
  costUsdNano: number,
) {
  await db
    .update(bookPages)
    .set({
      markdown: tidy(markdown),
      status: markdown ? 'parsed' : 'failed',
      flags: pageFlags(tidy(markdown)),
      error: markdown ? null : 'The parser returned no text',
      costUsdNano: sql`${bookPages.costUsdNano} + ${costUsdNano}`,
      updatedBy: userId,
      updatedAt: new Date(),
    })
    .where(and(eq(bookPages.bookId, bookId), eq(bookPages.pageNo, pageNo)));
}

/** Board answer scripts (decision 9.5-2): vision transcription, task vision_ocr. */
async function transcribeHandwriting(
  env: Env,
  db: Db,
  pdf: Uint8Array,
  pageNo: number,
  userId: string,
) {
  const res = await runMeteredChat(env, db, {
    task: 'vision_ocr',
    payers: [await platformWallet(db)],
    userId,
    maxTokens: 2500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: ANSWER_SCRIPT_PROMPT },
          {
            type: 'file',
            file: {
              filename: `page-${pageNo}.pdf`,
              file_data: `data:application/pdf;base64,${toBase64(pdf)}`,
            },
          },
        ],
      },
    ],
  });
  return { text: res.content.trim(), rawUsdNano: res.rawUsdNano };
}

export const ANSWER_SCRIPT_PROMPT = [
  "This is one scanned page (it may be rotated, and may show two facing pages) of a student's handwritten board-exam answer booklet in Accountancy that scored full marks.",
  "Transcribe it faithfully as Markdown, in reading order, keeping the student's own wording, numbers and layout:",
  '- Start each answer with its question number as a heading, e.g. "### Q30".',
  '- Journal entries, ledger/T-accounts, statements and working notes as Markdown tables, keeping Dr/Cr, L.F., ₹ columns, dates and narrations exactly as written.',
  '- Mark examiner marks or ticks (in red/green ink) as [examiner: …]; do not include signatures.',
  '- Do NOT transcribe names, register numbers, signatures or other personal details; write [personal detail removed] instead.',
  'Output only the Markdown. If the page is blank, output nothing.',
].join('\n');

/** OCR image placeholders, e.g. ![img-0.jpeg](img-0.jpeg). */
const IMAGE_REF = /!\[[^\]]*\]\([^)]*\)/;
const IMAGE_REF_ALL = /!\[[^\]]*\]\([^)]*\)/g;

/** Puts the figure descriptions where the first figure was, and removes the bare placeholders. */
export function withFigureDescriptions(markdown: string, descriptions: string): string {
  const text = descriptions.trim();
  let placed = false;
  return markdown
    .replace(IMAGE_REF_ALL, () => {
      if (placed || !text) return '';
      placed = true;
      return text;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function describeFigures(env: Env, db: Db, pdf: Uint8Array, pageNo: number, userId: string) {
  const res = await runMeteredChat(env, db, {
    task: 'figure_description',
    payers: [await platformWallet(db)],
    userId,
    maxTokens: 600,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'This is one page of a school textbook. For each figure, chart or diagram on it (not tables or plain text), in reading order, write one short paragraph starting with "**Figure:**" that describes what it shows for a student: labels, numbers, arrows/flow and the point it makes. Output only those paragraphs. If there are no figures, output nothing.',
          },
          {
            type: 'file',
            file: {
              filename: `page-${pageNo}.pdf`,
              file_data: `data:application/pdf;base64,${toBase64(pdf)}`,
            },
          },
        ],
      },
    ],
  });
  return { text: res.content, rawUsdNano: res.rawUsdNano };
}

async function runParse(env: Env, db: Db, p: IngestParams, step: StepRunner) {
  const book = await loadBook(db, p.bookId);
  await step.do('status: splitting', () => setStatus(db, p.bookId, 'splitting'));
  for (let a = 1; a <= book.pageCount; a += SPLIT_BATCH) {
    const b = Math.min(book.pageCount, a + SPLIT_BATCH - 1);
    await step.do(`split pages ${a}-${b}`, () => splitPages(env, p.bookId, a, b));
  }
  await step.do('status: parsing', () => setStatus(db, p.bookId, 'parsing'));
  for (let a = 1; a <= book.pageCount; a += PARSE_BATCH) {
    const b = Math.min(book.pageCount, a + PARSE_BATCH - 1);
    try {
      await step.do(`parse pages ${a}-${b}`, async () => {
        const pages = Array.from({ length: b - a + 1 }, (_, i) => a + i);
        const results = await Promise.allSettled(
          pages.map((n) => parsePage(env, db, p.bookId, n, p.userId)),
        );
        const stop = results.find((r) => r.status === 'rejected');
        if (stop?.status === 'rejected') throw stop.reason;
        return b;
      });
    } catch (err) {
      const msg =
        err instanceof InsufficientCredits
          ? `Stopped at page ${a}: the platform wallet ran out of credits. Issue platform credits, then press "Parse" again to continue.`
          : `Stopped at page ${a}: ${err instanceof Error ? err.message : String(err)}`;
      await step.do('status: failed', () => setStatus(db, p.bookId, 'failed', msg));
      return;
    }
  }
  await step.do('status: review', async () => {
    const failed = await db
      .select({ n: sql<number>`count(*)` })
      .from(bookPages)
      .where(and(eq(bookPages.bookId, p.bookId), eq(bookPages.status, 'failed')))
      .get();
    const n = Number(failed?.n ?? 0);
    await setStatus(
      db,
      p.bookId,
      'review',
      n ? `${n} page(s) failed to parse. Re-parse them before publishing.` : null,
    );
  });
}

// ---------------------------------------------------------------- publish

export interface Manifest {
  bookId: string;
  version: string;
  title: string;
  offeringId: string;
  edition: string | null;
  language: string;
  pageCount: number;
  chunkCount: number;
  embeddingModel: string;
  publishedAt: string;
  sourceEnv: string;
  /** Absent in packages published before Phase 3 (= textbook). */
  kind?: 'textbook' | 'board_material';
  category?: (typeof books.$inferSelect)['category'];
  academicYear?: string | null;
  relatedBookId?: string | null;
  removedPages?: number[] | null;
  removedReasons?: { pages: string; why: string }[] | null;
}

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');
export const parseJsonl = <T>(text: string): T[] =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

/**
 * Replaces this environment's chunks + FTS rows for a book (D1 only; the shared store is
 * append-only). Raw D1 statements: the FTS5 table is hand-written SQL, and both tables must change
 * in the same atomic batches.
 */
export async function writeChunksToD1(
  db: Db,
  bookId: string,
  version: string,
  rows: (Chunk & { id: string })[],
) {
  const d1 = db.$client;
  await d1.batch([
    d1.prepare('DELETE FROM chunks_fts WHERE book LIKE ?').bind(`${bookId}@%`),
    d1.prepare('DELETE FROM chunks WHERE book_id = ?').bind(bookId),
  ]);
  const tag = bookTag(bookId, version);
  const insChunk = d1.prepare(
    'INSERT INTO chunks (id, book_id, version, chunk_no, page_from, page_to, section, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insFts = d1.prepare(
    'INSERT INTO chunks_fts (chunk_id, book, section, text) VALUES (?, ?, ?, ?)',
  );
  // One row per statement keeps every statement far below D1's 100-parameter limit.
  for (let i = 0; i < rows.length; i += 50) {
    await d1.batch(
      rows
        .slice(i, i + 50)
        .flatMap((c) => [
          insChunk.bind(c.id, bookId, version, c.chunkNo, c.pageFrom, c.pageTo, c.section, c.text),
          insFts.bind(c.id, tag, c.section ?? '', c.text),
        ]),
    );
  }
}

async function runPublish(env: Env, db: Db, p: IngestParams, step: StepRunner) {
  const book = await loadBook(db, p.bookId);
  const version = `v${book.nextVersion}`;
  const bucket = contentBucket(env);
  await step.do('status: publishing', () => setStatus(db, p.bookId, 'publishing'));

  // 1. Chunk the reviewed pages and stage them in the package (immutable once the manifest exists).
  const chunkCount = await step.do(`chunk ${version}`, async () => {
    const pages = await db
      .select({ pageNo: bookPages.pageNo, markdown: bookPages.markdown, status: bookPages.status })
      .from(bookPages)
      .where(eq(bookPages.bookId, p.bookId))
      .orderBy(asc(bookPages.pageNo));
    const notReady = pages.filter((x) => x.status === 'pending' || x.status === 'failed');
    if (notReady.length)
      throw new Error(
        `${notReady.length} page(s) are not parsed yet (e.g. page ${notReady[0]!.pageNo})`,
      );
    const list = chunkPages(pages.map((x) => ({ pageNo: x.pageNo, markdown: x.markdown ?? '' })));
    const rows = list.map((c) => ({ id: `${p.bookId}:${version}:${c.chunkNo}`, ...c }));
    await bucket.put(
      keys.pkg(p.bookId, version, 'pages.jsonl'),
      jsonl(pages.map((x) => ({ page: x.pageNo, markdown: x.markdown ?? '' }))),
    );
    await bucket.put(keys.pkg(p.bookId, version, 'chunks.jsonl'), jsonl(rows));
    return rows.length;
  });

  // 2. Embed + index in batches (each batch is its own retryable step).
  const emb = embedder(env);
  for (let i = 0; i < chunkCount; i += EMBED_BATCH) {
    await step.do(
      `embed ${version} ${i + 1}-${Math.min(chunkCount, i + EMBED_BATCH)}`,
      async () => {
        const obj = await bucket.get(keys.pkg(p.bookId, version, 'chunks.jsonl'));
        const rows = parseJsonl<Chunk & { id: string }>(await obj!.text()).slice(
          i,
          i + EMBED_BATCH,
        );
        const vectors = await emb.embed(
          rows.map((r) => (r.section ? `${r.section}\n${r.text}` : r.text)),
        );
        await vectorStore(env).upsert(
          rows.map((r, k) => ({
            id: r.id,
            values: vectors[k]!,
            metadata: { book: bookTag(p.bookId, version), page: r.pageFrom, chunk: r.chunkNo },
          })),
        );
        return rows.length;
      },
    );
  }

  // 3. Manifest last (marks the version complete), catalog entry, then this environment's D1.
  await step.do(`finalize ${version}`, async () => {
    const manifest: Manifest = {
      bookId: book.id,
      version,
      title: book.title,
      offeringId: book.offeringId,
      edition: book.edition,
      language: book.language,
      pageCount: book.pageCount,
      chunkCount,
      embeddingModel: emb.model,
      publishedAt: new Date().toISOString(),
      sourceEnv: env.APP_ENV,
      kind: book.kind,
      category: book.category,
      academicYear: book.academicYear,
      relatedBookId: book.relatedBookId,
      removedPages: book.removedPages,
      removedReasons: book.removedReasons,
    };
    await bucket.put(keys.pkg(p.bookId, version, 'manifest.json'), JSON.stringify(manifest));
    await bucket.put(keys.catalog(p.bookId), JSON.stringify(manifest));
    const obj = await bucket.get(keys.pkg(p.bookId, version, 'chunks.jsonl'));
    await writeChunksToD1(db, p.bookId, version, parseJsonl(await obj!.text()));
    await db
      .update(books)
      .set({
        status: 'published',
        statusMessage: null,
        publishedVersion: version,
        nextVersion: book.nextVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(books.id, p.bookId));
  });
}

/** Entry point used by the Workflow (and inline in tests). */
export async function runIngest(env: Env, db: Db, p: IngestParams, step: StepRunner) {
  try {
    if (p.phase === 'parse') await runParse(env, db, p, step);
    else await runPublish(env, db, p, step);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setStatus(db, p.bookId, p.phase === 'parse' ? 'failed' : 'review', `Stopped: ${msg}`);
    throw err;
  }
}

/** Pages per status for progress displays. */
export async function pageCounts(db: Db, bookIds: string[]) {
  if (!bookIds.length) return new Map<string, Record<string, number>>();
  const rows = await db
    .select({ bookId: bookPages.bookId, status: bookPages.status, n: sql<number>`count(*)` })
    .from(bookPages)
    .where(inArray(bookPages.bookId, bookIds.slice(0, 90)))
    .groupBy(bookPages.bookId, bookPages.status);
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const m = out.get(r.bookId) ?? {};
    m[r.status] = Number(r.n);
    out.set(r.bookId, m);
  }
  return out;
}
