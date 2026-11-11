import { env } from 'cloudflare:workers';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkPages, pageFlags } from '../src/content/chunk';
import { withFigureDescriptions } from '../src/content/ingest';
import type { Env as AppEnv } from '../src/env';
import { PROCESS_ON_LOCAL, processingEnabled } from '../src/routes/books';
import { testVectors } from '../src/content/store';
import { clearRegistryCache } from '../src/llm/registry';
import { call, createSignedInUser, json, seedPilotTaxonomy, type Jar } from './helpers';
import { installOpenRouterMock, type MockState } from './openrouter-mock';

/** Phase 2 ingestion: upload → parse → review → publish (shared store) → import elsewhere. */

const TABLES = [
  'institution_books',
  'chunks',
  'book_pages',
  'books',
  'ledger_entries',
  'llm_usage',
  'credit_holds',
  'allotments',
  'payments',
  'wallets',
  'model_registry',
  'platform_settings',
];
let or: MockState;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks_fts'),
    ...TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  ]);
  testVectors.clear();
  or = installOpenRouterMock();
  clearRegistryCache();
});
afterEach(() => vi.restoreAllMocks());

describe('chunking', () => {
  const header = 'Accountancy – Not-for-Profit Organisation and Partnership Accounts';
  const pages = Array.from({ length: 5 }, (_, i) => ({
    pageNo: i + 1,
    markdown: `${header}\n\n## 1.${i} Topic ${i}\n\n${'Goodwill is valued. '.repeat(20)}\n\n|  Particulars | Amount |\n| --- | --- |\n| Cash | 5,000 |\n| Stock | 25,000 |\n\n${i + 10}`,
  }));

  it('drops running headers and page numbers, keeps tables whole, never crosses pages', () => {
    const chunks = chunkPages(pages);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) {
      expect(c.pageFrom).toBe(c.pageTo);
      expect(c.text).not.toContain(header);
      expect(c.text).not.toMatch(/\n1\d$/);
    }
    // The table is in one chunk, complete
    const withTable = chunks.find((c) => c.pageFrom === 3 && c.text.includes('| Cash'))!;
    expect(withTable.text).toContain('| Stock | 25,000 |');
    expect(withTable.section).toBe('1.2 Topic 2');
  });

  it('flags empty and garbled pages for review', () => {
    expect(pageFlags('')).toEqual(['empty']);
    expect(pageFlags('Short page text that is real.')).toEqual(['empty']);
    expect(pageFlags('A'.repeat(50))).toEqual(['short']);
    expect(
      pageFlags('|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|#|# x'),
    ).toContain('garbled');
    expect(pageFlags('Partnership accounts. '.repeat(20))).toEqual([]);
  });
});

async function makePdf(pages: number) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

async function upload(jar: Jar, offeringId: string, pages = 3) {
  const form = new FormData();
  form.set(
    'file',
    new File([await makePdf(pages)], 'accountancy.pdf', { type: 'application/pdf' }),
  );
  form.set('title', 'NCERT Accountancy Part I');
  form.set('offeringId', offeringId);
  return call('POST', '/api/admin/books', { jar, multipart: form });
}

const fts = async (q: string) =>
  (
    await env.DB.prepare('SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ?').bind(q).all<{
      chunk_id: string;
    }>()
  ).results.map((r) => r.chunk_id);

describe('textbook ingestion (shared content store)', () => {
  it('upload → parse (platform wallet pays) → review → publish → import elsewhere', async () => {
    const offeringId = await seedPilotTaxonomy();
    const admin = await createSignedInUser('admin');
    const teacher = await createSignedInUser('teacher');
    expect((await call('POST', '/api/admin/models/sync', { jar: admin.jar })).status).toBe(200);
    or.parseText = (f) =>
      f === 'page-2.pdf'
        ? '## 2.1 Goodwill\n\nGoodwill is the value of the reputation of a firm.'
        : `## Section\n\nText of ${f} about partnership deeds and capital accounts.`;

    // Admin only
    expect((await upload(teacher.jar, offeringId)).status).toBe(403);
    const up = await upload(admin.jar, offeringId);
    expect(up.status).toBe(201);
    const { id, pageCount } = await json(up);
    expect(pageCount).toBe(3);
    // Not a PDF
    const bad = new FormData();
    bad.set('file', new File(['hello'], 'x.pdf'));
    bad.set('title', 'Broken');
    bad.set('offeringId', offeringId);
    expect(
      (await call('POST', '/api/admin/books', { jar: admin.jar, multipart: bad })).status,
    ).toBe(400);

    // Parse with an empty platform wallet: stops with a clear message, nothing parsed
    await call('POST', `/api/admin/books/${id}/parse`, { jar: admin.jar, body: {} });
    let view = await json(await call('GET', `/api/admin/books/${id}`, { jar: admin.jar }));
    expect(view.book.status).toBe('failed');
    expect(view.book.statusMessage).toMatch(/ran out of credits/);

    // Fund the platform wallet, parse again: every page parsed via the file-parser plugin
    await call('POST', '/api/admin/credits/issue', {
      jar: admin.jar,
      body: { target: { type: 'platform' }, credits: '50' },
    });
    or.costUsd = 0.0022;
    expect(
      (await call('POST', `/api/admin/books/${id}/parse`, { jar: admin.jar, body: {} })).status,
    ).toBe(202);
    view = await json(await call('GET', `/api/admin/books/${id}`, { jar: admin.jar }));
    expect(view.book.status).toBe('review');
    expect(view.pages.map((p: any) => p.status)).toEqual(['parsed', 'parsed', 'parsed']);
    expect(view.parseCostUsdNano).toBe(3 * 2_200_000);
    expect(or.parsedFiles.sort()).toEqual(['page-1.pdf', 'page-2.pdf', 'page-3.pdf']);
    // The <file> wrapper is stripped
    const p2 = await json(await call('GET', `/api/admin/books/${id}/pages/2`, { jar: admin.jar }));
    expect(p2.markdown).toBe(
      '## 2.1 Goodwill\n\nGoodwill is the value of the reputation of a firm.',
    );
    // Each page is a one-page PDF in the store, served for review
    const pdf = await call('GET', `/api/admin/books/${id}/pages/2/pdf`, { jar: admin.jar });
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect((await PDFDocument.load(await pdf.arrayBuffer())).getPageCount()).toBe(1);
    // Charged at cost (platform pays no fee): 3 × $0.0022 × ₹88
    const usage = await env.DB.prepare(
      "SELECT sum(billed_micro) b, count(*) n FROM llm_usage WHERE task = 'pdf_parse'",
    ).first<{ b: number; n: number }>();
    expect(usage).toEqual({ b: 3 * 193_600, n: 3 });

    // Review: edit page 3, approve page 1
    await call('PUT', `/api/admin/books/${id}/pages/3`, {
      jar: admin.jar,
      body: {
        markdown: '## 3.1 Revaluation\n\nRevaluation account records changes in asset values.',
      },
    });
    await call('PUT', `/api/admin/books/${id}/pages/1`, { jar: admin.jar, body: {} });
    view = await json(await call('GET', `/api/admin/books/${id}`, { jar: admin.jar }));
    expect(view.pages.map((p: any) => p.status)).toEqual(['approved', 'parsed', 'edited']);

    // Publish v1: vectors in the shared index, package + catalog in R2, chunks + FTS in D1
    expect(
      (await call('POST', `/api/admin/books/${id}/publish`, { jar: admin.jar, body: {} })).status,
    ).toBe(202);
    view = await json(await call('GET', `/api/admin/books/${id}`, { jar: admin.jar }));
    expect(view.book).toMatchObject({ status: 'published', publishedVersion: 'v1' });
    const v1 = [...testVectors.values()].filter((v) => v.metadata.book === `${id}@v1`);
    expect(v1.length).toBe(3);
    expect(v1.find((v) => v.metadata.page === 2)!.id).toBe(`${id}:v1:2`);
    expect(await fts('goodwill')).toEqual([`${id}:v1:2`]);
    expect(await fts('revaluation')).toEqual([`${id}:v1:3`]);
    for (const f of ['manifest.json', 'pages.jsonl', 'chunks.jsonl'])
      expect(await env.CONTENT.head(`books/${id}/v1/${f}`)).not.toBeNull();

    // Republish → v2. The shared store is append-only: v1 vectors are still there.
    await call('PUT', `/api/admin/books/${id}/pages/2`, {
      jar: admin.jar,
      body: { markdown: '## 2.1 Goodwill\n\nGoodwill and its valuation methods.' },
    });
    await call('POST', `/api/admin/books/${id}/publish`, { jar: admin.jar, body: {} });
    view = await json(await call('GET', `/api/admin/books/${id}`, { jar: admin.jar }));
    expect(view.book.publishedVersion).toBe('v2');
    expect([...testVectors.values()].filter((v) => v.metadata.book === `${id}@v1`).length).toBe(3);
    expect([...testVectors.values()].filter((v) => v.metadata.book === `${id}@v2`).length).toBe(3);
    expect(await fts('valuation')).toEqual([`${id}:v2:2`]);

    // Map to an institution
    const inst = await json(
      await call('POST', '/api/admin/institutions', {
        jar: admin.jar,
        body: { name: 'Book College', type: 'college' },
      }),
    );
    expect(
      (
        await call('PUT', `/api/admin/books/${id}/institutions`, {
          jar: admin.jar,
          body: { institutionIds: [inst.id] },
        })
      ).status,
    ).toBe(200);
    view = await json(await call('GET', `/api/admin/books/${id}`, { jar: admin.jar }));
    expect(view.institutions).toEqual([{ id: inst.id, name: 'Book College' }]);

    // "Another environment": its D1 has no rows for the book, but the shared store does.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM institution_books'),
      env.DB.prepare('DELETE FROM chunks_fts'),
      env.DB.prepare('DELETE FROM chunks'),
      env.DB.prepare('DELETE FROM book_pages'),
      env.DB.prepare('DELETE FROM books'),
    ]);
    const parsedBefore = or.parsedFiles.length;
    let shared = await json<any[]>(
      await call('GET', '/api/admin/books/shared', { jar: admin.jar }),
    );
    expect(shared).toEqual([
      expect.objectContaining({
        bookId: id,
        version: 'v2',
        chunkCount: 3,
        localVersion: null,
        upToDate: false,
      }),
    ]);
    const imp = await call('POST', `/api/admin/books/shared/${id}/import`, {
      jar: admin.jar,
      body: {},
    });
    expect(imp.status).toBe(200);
    expect(await json(imp)).toEqual({ bookId: id, version: 'v2', pages: 3, chunks: 3 });
    shared = await json<any[]>(await call('GET', '/api/admin/books/shared', { jar: admin.jar }));
    expect(shared[0].upToDate).toBe(true);
    view = await json(await call('GET', `/api/admin/books/${id}`, { jar: admin.jar }));
    expect(view.book).toMatchObject({
      source: 'imported',
      status: 'published',
      publishedVersion: 'v2',
    });
    expect(await fts('valuation')).toEqual([`${id}:v2:2`]);
    // No re-parsing and no re-processing of imported books
    expect(or.parsedFiles.length).toBe(parsedBefore);
    expect(
      (await call('POST', `/api/admin/books/${id}/parse`, { jar: admin.jar, body: {} })).status,
    ).toBe(400);
  });
});

describe('where books can be processed', () => {
  it('only where the ingestion Workflow is bound (local) or in tests; staging refuses uploads', async () => {
    const workflow = {} as NonNullable<AppEnv['INGEST_BOOK']>;
    expect(processingEnabled({ APP_ENV: 'staging', INGEST_BOOK: undefined })).toBe(false);
    expect(processingEnabled({ APP_ENV: 'development', INGEST_BOOK: workflow })).toBe(true);
    expect(processingEnabled({ APP_ENV: 'test', INGEST_BOOK: undefined })).toBe(true);
    expect(PROCESS_ON_LOCAL).toBe('Process books on local, then import them here.');
    const admin = await createSignedInUser('admin');
    const res = await call('GET', '/api/admin/books/settings', { jar: admin.jar });
    expect(await json(res)).toEqual({ processingEnabled: true });
  });
});

describe('a run that stopped (e.g. the dev server reloaded mid-reading)', () => {
  it('is shown as stalled after 10 minutes without progress and can be continued', async () => {
    const offeringId = await seedPilotTaxonomy();
    const admin = await createSignedInUser('admin');
    await call('POST', '/api/admin/models/sync', { jar: admin.jar });
    await call('POST', '/api/admin/credits/issue', {
      jar: admin.jar,
      body: { target: { type: 'platform' }, credits: '5' },
    });
    const { id } = await json(await upload(admin.jar, offeringId, 2));
    // The run "died" while parsing: status says parsing, page 1 done, page 2 pending.
    const at = async (ms: number) => {
      await env.DB.batch([
        env.DB.prepare("UPDATE books SET status = 'parsing', updated_at = ? WHERE id = ?").bind(
          ms,
          id,
        ),
        env.DB.prepare(
          "UPDATE book_pages SET status = 'parsed', markdown = 'Done before.', updated_at = ? WHERE book_id = ? AND page_no = 1",
        ).bind(ms, id),
        env.DB.prepare(
          'UPDATE book_pages SET updated_at = ? WHERE book_id = ? AND page_no = 2',
        ).bind(ms, id),
      ]);
    };
    const view = async () => json(await call('GET', `/api/admin/books/${id}`, { jar: admin.jar }));
    const parse = () => call('POST', `/api/admin/books/${id}/parse`, { jar: admin.jar, body: {} });

    await at(Date.now() - 60_000); // 1 minute ago: still running
    expect((await view()).stalled).toBe(false);
    expect((await parse()).status).toBe(409);

    await at(Date.now() - 11 * 60_000); // 11 minutes without progress: stopped
    expect((await view()).stalled).toBe(true);
    expect((await parse()).status).toBe(202);
    const after = await view();
    expect(after.book.status).toBe('review');
    expect(after.stalled).toBe(false);
    // Only the missing page was read again; page 1 kept its text
    expect(or.parsedFiles).toEqual(['page-2.pdf']);
    const p1 = await json(await call('GET', `/api/admin/books/${id}/pages/1`, { jar: admin.jar }));
    expect(p1.markdown).toBe('Done before.');
  });
});

describe('board material (decision 9.5-2)', () => {
  async function uploadBoard(
    jar: Jar,
    offeringId: string,
    pages: number,
    fields: Record<string, string>,
  ) {
    const form = new FormData();
    form.set('file', new File([await makePdf(pages)], 'script.pdf', { type: 'application/pdf' }));
    form.set('title', 'Centum answer script 1 (2026)');
    form.set('offeringId', offeringId);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return call('POST', '/api/admin/books', { jar, multipart: form });
  }

  it('removes cover pages before storing, reads handwriting with the vision task, stays out of Ask', async () => {
    const offeringId = await seedPilotTaxonomy();
    const admin = await createSignedInUser('admin');
    await call('POST', '/api/admin/models/sync', { jar: admin.jar });
    await call('POST', '/api/admin/credits/issue', {
      jar: admin.jar,
      body: { target: { type: 'platform' }, credits: '5' },
    });
    // Board material needs a category and a year; page lists are validated
    expect((await uploadBoard(admin.jar, offeringId, 3, { kind: 'board_material' })).status).toBe(
      400,
    );
    const bad = await uploadBoard(admin.jar, offeringId, 3, {
      kind: 'board_material',
      category: 'answer_script',
      academicYear: '2025-26',
      removePages: '1-3',
    });
    expect(bad.status).toBe(400);

    // A reason may only describe pages that are removed (original page numbers)
    const wrongReason = await uploadBoard(admin.jar, offeringId, 3, {
      kind: 'board_material',
      category: 'answer_script',
      academicYear: '2025-26',
      removePages: '1',
      removeReasons: JSON.stringify([{ pages: '2', why: 'Not actually removed' }]),
    });
    expect(wrongReason.status).toBe(400);
    const up = await uploadBoard(admin.jar, offeringId, 3, {
      kind: 'board_material',
      category: 'answer_script',
      academicYear: '2025-26',
      removePages: '1',
      removeReasons: JSON.stringify([{ pages: '1', why: 'Cover page with the register number' }]),
    });
    expect(up.status).toBe(201);
    const { id, pageCount } = await json(up);
    expect(pageCount).toBe(2);
    // The stored PDF no longer has the cover page
    const stored = await env.CONTENT.get(`books/${id}/original.pdf`);
    expect((await PDFDocument.load(await stored!.arrayBuffer())).getPageCount()).toBe(2);
    let view = await json(await call('GET', `/api/admin/books/${id}`, { jar: admin.jar }));
    expect(view.book).toMatchObject({
      kind: 'board_material',
      category: 'answer_script',
      academicYear: '2025-26',
      removedPages: [1],
      removedReasons: [{ pages: '1', why: 'Cover page with the register number' }],
    });

    // Handwritten pages: vision transcription (task vision_ocr), not the OCR file-parser
    or.answer =
      '### Q30\n\n| Particulars | Dr | Cr |\n| --- | --- | --- |\n| Bank A/c | 90,000 | |';
    await call('POST', `/api/admin/books/${id}/parse`, { jar: admin.jar, body: {} });
    view = await json(await call('GET', `/api/admin/books/${id}`, { jar: admin.jar }));
    expect(view.book.status).toBe('review');
    expect(or.parsedFiles).toEqual([]);
    const tasks = await env.DB.prepare('SELECT DISTINCT task FROM llm_usage WHERE task != ?')
      .bind('playground')
      .all<{ task: string }>();
    expect(tasks.results.map((r) => r.task)).toEqual(['vision_ocr']);
    const p1 = await json(await call('GET', `/api/admin/books/${id}/pages/1`, { jar: admin.jar }));
    expect(p1.markdown).toContain('### Q30');

    // Published to the shared store with its labels; never searched by Ask
    await call('POST', `/api/admin/books/${id}/publish`, { jar: admin.jar, body: {} });
    const manifest = await (await env.CONTENT.get(`catalog/${id}.json`))!.json<any>();
    expect(manifest).toMatchObject({ kind: 'board_material', category: 'answer_script' });
    // Reasons changed after publishing (e.g. recorded later): the catalog entry carries them too
    const why = [{ pages: '1', why: 'Cover page: register number and signatures' }];
    expect(
      (
        await call('PUT', `/api/admin/books/${id}/removed-reasons`, {
          jar: admin.jar,
          body: { reasons: [{ pages: '1-2', why: 'Too many pages' }] },
        })
      ).status,
    ).toBe(400);
    await call('PUT', `/api/admin/books/${id}/removed-reasons`, {
      jar: admin.jar,
      body: { reasons: why },
    });
    expect(await (await env.CONTENT.get(`catalog/${id}.json`))!.json<any>()).toMatchObject({
      removedReasons: why,
    });
    const scope = await json(await call('GET', '/api/ask/scope', { jar: admin.jar }));
    expect(scope.books.map((b: any) => b.id)).not.toContain(id);

    // Another environment imports it as board material
    await env.DB.batch([
      env.DB.prepare('DELETE FROM chunks_fts'),
      env.DB.prepare('DELETE FROM chunks'),
      env.DB.prepare('DELETE FROM book_pages'),
      env.DB.prepare('DELETE FROM books'),
    ]);
    await call('POST', `/api/admin/books/shared/${id}/import`, { jar: admin.jar, body: {} });
    view = await json(await call('GET', `/api/admin/books/${id}`, { jar: admin.jar }));
    expect(view.book).toMatchObject({
      kind: 'board_material',
      category: 'answer_script',
      source: 'imported',
      removedPages: [1],
      removedReasons: [{ pages: '1', why: 'Cover page: register number and signatures' }],
    });
  });

  it('links a scheme of evaluation to its paper; textbooks cannot have a category', async () => {
    const offeringId = await seedPilotTaxonomy();
    const admin = await createSignedInUser('admin');
    const paper = await json(
      await uploadBoard(admin.jar, offeringId, 2, {
        kind: 'board_material',
        category: 'board_paper',
        academicYear: '2025-26',
      }),
    );
    const scheme = await uploadBoard(admin.jar, offeringId, 1, {
      kind: 'board_material',
      category: 'scheme',
      academicYear: '2025-26',
      relatedBookId: paper.id,
    });
    expect(scheme.status).toBe(201);
    expect(
      (
        await uploadBoard(admin.jar, offeringId, 1, {
          kind: 'board_material',
          category: 'scheme',
          academicYear: '2025-26',
          relatedBookId: 'nope',
        })
      ).status,
    ).toBe(404);
    expect((await uploadBoard(admin.jar, offeringId, 1, { category: 'scheme' })).status).toBe(400);
  });
});

describe('large uploads', () => {
  it('uploads a book-sized PDF (page rows stay under the D1 parameter limit)', async () => {
    const offeringId = await seedPilotTaxonomy();
    const admin = await createSignedInUser('admin');
    const up = await upload(admin.jar, offeringId, 296);
    expect(up.status).toBe(201);
    const { id, pageCount } = await json(up);
    expect(pageCount).toBe(296);
    const n = await env.DB.prepare('SELECT count(*) n FROM book_pages WHERE book_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(n?.n).toBe(296);
  });
});

describe('figures', () => {
  it('replaces OCR image placeholders with figure descriptions', () => {
    expect(
      withFigureDescriptions(
        'Intro\n\n![img-0.jpeg](img-0.jpeg)\n\nMore\n\n![img-1.jpeg](img-1.jpeg)',
        '**Figure:** A chart.',
      ),
    ).toBe('Intro\n\n**Figure:** A chart.\n\nMore');
    expect(withFigureDescriptions('Text ![x](x.png)', '')).toBe('Text');
  });

  it('describes figures during parsing (second metered call, platform wallet)', async () => {
    const offeringId = await seedPilotTaxonomy();
    const admin = await createSignedInUser('admin');
    await call('POST', '/api/admin/models/sync', { jar: admin.jar });
    await call('POST', '/api/admin/credits/issue', {
      jar: admin.jar,
      body: { target: { type: 'platform' }, credits: '5' },
    });
    or.parseText = () =>
      '## Sources of finance\n\n![img-0.jpeg](img-0.jpeg)\n\nText around the chart.';
    or.answer = '**Figure:** A chart dividing sources of finance into owned and borrowed funds.';
    const { id } = await json(await upload(admin.jar, offeringId, 1));
    await call('POST', `/api/admin/books/${id}/parse`, { jar: admin.jar, body: {} });
    const page = await json(
      await call('GET', `/api/admin/books/${id}/pages/1`, { jar: admin.jar }),
    );
    expect(page.markdown).toContain('**Figure:** A chart dividing sources of finance');
    expect(page.markdown).not.toContain('![img-0');
    const tasks = await env.DB.prepare('SELECT task FROM llm_usage ORDER BY created_at').all<{
      task: string;
    }>();
    expect(tasks.results.map((r) => r.task)).toEqual(['pdf_parse', 'figure_description']);
  });
});
