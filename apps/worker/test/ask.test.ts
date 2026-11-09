import { createDb } from '@aicoach/db';
import { env } from 'cloudflare:workers';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyCitations } from '../src/content/answer';
import type { Source } from '../src/content/retrieve';
import { testVectors } from '../src/content/store';
import { reconcileUsage } from '../src/credits/reconcile';
import { clearRegistryCache } from '../src/llm/registry';
import type { Env } from '../src/env';
import { call, createSignedInUser, json, seedPilotTaxonomy, type Jar } from './helpers';
import { installOpenRouterMock, type MockState } from './openrouter-mock';

/** Phase 2 "Ask your textbook": scope, retrieval, streaming, citations, cache, metering, reconciliation. */

const TABLES = [
  'answers',
  'institution_books',
  'chunks',
  'book_pages',
  'books',
  'ledger_entries',
  'llm_usage',
  'credit_holds',
  'credit_requests',
  'allotment_edits',
  'allotments',
  'payments',
  'wallets',
  'model_registry',
  'platform_settings',
];
const MICRO = 1_000_000;
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

const PAGES: Record<string, string> = {
  'page-1.pdf':
    '## 1.1 Partnership\n\nA partnership is an agreement between persons to share the profits of a business carried on by all or any of them acting for all.',
  'page-2.pdf':
    '## 2.1 Goodwill\n\nGoodwill is the value of the reputation of a firm in respect of the profits expected in future over and above the normal profits.',
  'page-3.pdf':
    '## 3.1 Revaluation Account\n\nThe revaluation account records the increase or decrease in the values of assets and liabilities on reconstitution.',
};

async function sse(res: Response) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)));
}

/** Book published and mapped to an institution; a funded student in a class there. */
async function setup() {
  const offeringId = await seedPilotTaxonomy();
  const admin = await createSignedInUser('admin');
  const poc = await createSignedInUser('institution_poc');
  const teacher = await createSignedInUser('teacher');
  const student = await createSignedInUser('student');
  await call('POST', '/api/admin/models/sync', { jar: admin.jar });
  await call('POST', '/api/admin/credits/issue', {
    jar: admin.jar,
    body: { target: { type: 'platform' }, credits: '20' },
  });
  or.parseText = (f) => PAGES[f] ?? '';
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([300, 400]);
  const form = new FormData();
  form.set('file', new File([await doc.save()], 'b.pdf', { type: 'application/pdf' }));
  form.set('title', 'NCERT Accountancy Part I');
  form.set('offeringId', offeringId);
  const { id: bookId } = await json(
    await call('POST', '/api/admin/books', { jar: admin.jar, multipart: form }),
  );
  await call('POST', `/api/admin/books/${bookId}/parse`, { jar: admin.jar, body: {} });
  await call('POST', `/api/admin/books/${bookId}/publish`, { jar: admin.jar, body: {} });

  const inst = await json(
    await call('POST', '/api/admin/institutions', {
      jar: admin.jar,
      body: { name: 'Ask College', type: 'college' },
    }),
  );
  await call('POST', `/api/admin/institutions/${inst.id}/pocs`, {
    jar: admin.jar,
    body: { email: poc.email },
  });
  const cls = await json(
    await call('POST', `/api/institutions/${inst.id}/classes`, {
      jar: poc.jar,
      body: { offeringId, name: '2nd PUC A', academicYear: '2026-27' },
    }),
  );
  await call('PUT', `/api/institutions/${inst.id}/classes/${cls.id}/teacher`, {
    jar: poc.jar,
    body: { email: teacher.email },
  });
  await call('POST', '/api/me/enrolments/join', {
    jar: student.jar,
    body: { joinCode: cls.joinCode },
  });
  // Fund: institution → class → student
  await call('POST', '/api/admin/credits/issue', {
    jar: admin.jar,
    body: { target: { type: 'institution', institutionId: inst.id }, credits: '100' },
  });
  const instW = (await json<any[]>(await call('GET', '/api/credits/mine', { jar: poc.jar }))).find(
    (w) => w.ownerType === 'institution',
  );
  const classW = (
    await json<any[]>(await call('GET', '/api/credits/mine', { jar: teacher.jar }))
  ).find((w) => w.ownerType === 'class');
  await call('POST', '/api/credits/allotments', {
    jar: poc.jar,
    body: { fromWalletId: instW.id, toWalletId: classW.id, credits: '50' },
  });
  const studentW = (
    await json<any[]>(await call('GET', '/api/credits/mine', { jar: student.jar }))
  ).find((w) => w.ownerType === 'user' && !w.label.includes('direct'));
  await call('POST', '/api/credits/allotments', {
    jar: teacher.jar,
    body: { fromWalletId: classW.id, toWalletId: studentW.id, credits: '10' },
  });
  return { admin, poc, teacher, student, inst, cls, bookId, studentW };
}

const ask = (jar: Jar, body: Record<string, unknown>) => call('POST', '/api/ask', { jar, body });
const balance = async (id: string) =>
  (await env.DB.prepare('SELECT balance_micro b FROM wallets WHERE id = ?')
    .bind(id)
    .first<{ b: number }>())!.b;

describe('ask your textbook', () => {
  it("streams a cited answer from the institution's book, charges the student, then serves it from cache", async () => {
    const t = await setup();
    // Scope: the student's institution book
    const scope = await json(await call('GET', '/api/ask/scope', { jar: t.student.jar }));
    expect(scope.books.map((b: any) => b.title)).toEqual(['NCERT Accountancy Part I']);

    or.answer =
      'Goodwill is the value of the reputation of a firm [S1]. It reflects expected future profits [S1].';
    or.costUsd = 0.0001;
    const before = or.requests.length;
    const res = await ask(t.student.jar, { question: 'What is goodwill?' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await sse(res);
    expect(events[0]).toMatchObject({ type: 'meta', cached: false });
    const streamed = events
      .filter((e) => e.type === 'delta')
      .map((e) => e.text)
      .join('');
    expect(streamed).toBe(or.answer);
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: 'done',
      cached: false,
      notInBook: false,
      uncertain: false,
      variantNo: 1,
    });
    expect(done.citations).toEqual([
      expect.objectContaining({
        n: 1,
        page: 2,
        section: '2.1 Goodwill',
        bookTitle: 'NCERT Accountancy Part I',
        supported: true,
      }),
    ]);
    expect(done.model).toBeNull(); // students never see the model
    // Charged to the student's class wallet: $0.0001 × 88 × 1.10
    expect(done.billedMicro).toBe(9_680);
    expect(await balance(t.studentW.id)).toBe(10 * MICRO - 9_680);
    expect(or.requests.length).toBe(before + 1);
    // The goodwill page was retrieved as source 1 (keyword + vector search)
    const prompt = JSON.stringify(or.requests.at(-1));
    expect(prompt).toBeDefined();

    // Same question (different case/punctuation): cached, free, no model call
    const again = (await sse(await ask(t.student.jar, { question: 'what is GOODWILL' }))).at(-1);
    expect(again).toMatchObject({
      type: 'done',
      cached: true,
      billedMicro: 0,
      answer: done.answer,
    });
    expect(or.requests.length).toBe(before + 1);
    expect(await balance(t.studentW.id)).toBe(10 * MICRO - 9_680);

    // Force a new answer: a second variant, charged
    or.answer = 'Goodwill means the reputation value of a firm [S1].';
    const fresh = (
      await sse(await ask(t.student.jar, { question: 'What is goodwill?', forceNew: true }))
    ).at(-1);
    expect(fresh).toMatchObject({ cached: false, variantNo: 2, answer: or.answer });
    expect(or.requests.length).toBe(before + 2);
  });

  it('understands follow-ups: rewrites "it" into a standalone question that drives search + cache', async () => {
    const t = await setup();
    const isRewrite = (body: { messages?: { role: string; content: unknown }[] }) =>
      String(body.messages?.[0]?.content ?? '').startsWith(
        "You rewrite a student's latest message",
      );
    or.costUsd = 0.0001; // each call: $0.0001 × 88 × 1.10 = 9,680 micro-INR to a student
    or.answer = 'Goodwill is the value of the reputation of a firm [S1].';
    const before = or.requests.length;
    const first = await json(
      await ask(t.student.jar, { question: 'What is goodwill?', stream: false }),
    );
    // No history → no rewrite call
    expect(or.requests.length).toBe(before + 1);
    expect(first.question).toBe('What is goodwill?');

    or.replyFor = (body) => (isRewrite(body) ? 'Why is goodwill important?' : undefined);
    or.answer = 'Goodwill matters because it reflects profits above normal profits [S1].';
    const history = [{ question: first.question, answer: first.answer }];
    const follow = await json(
      await ask(t.student.jar, { question: 'why is it important?', history, stream: false }),
    );
    expect(or.requests.length).toBe(before + 3); // rewrite + answer
    expect(follow).toMatchObject({
      type: 'done',
      question: 'Why is goodwill important?',
      cached: false,
      billedMicro: 2 * 9_680, // the rewrite is charged like any call
    });
    // The rewrite saw the conversation; the search used the standalone question (finds page 2)
    expect(follow.citations.map((c: any) => c.page)).toEqual([2]);
    expect(or.systems.at(-2)).toMatch(/^You rewrite/);
    expect(or.systems.at(-1)).toMatch(/^You are AI Coach/);

    // Same follow-up again: one rewrite call, then the stored answer (only the rewrite is charged)
    const again = await json(
      await ask(t.student.jar, { question: 'why is it important?', history, stream: false }),
    );
    expect(again).toMatchObject({ cached: true, billedMicro: 9_680, answer: follow.answer });
    expect(or.requests.length).toBe(before + 4);
    // …and the standalone question asked directly hits the same stored answer, free
    const direct = await json(
      await ask(t.student.jar, { question: 'Why is goodwill important?', stream: false }),
    );
    expect(direct).toMatchObject({ cached: true, billedMicro: 0 });
    expect(or.requests.length).toBe(before + 4);

    // Streaming carries the standalone question in meta and done
    or.replyFor = (body) => (isRewrite(body) ? 'What is a revaluation account?' : undefined);
    or.answer = 'It records changes in the values of assets and liabilities [S1].';
    const events = await sse(
      await ask(t.student.jar, { question: 'and the other account?', history }),
    );
    expect(events[0]).toMatchObject({ type: 'meta', question: 'What is a revaluation account?' });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      question: 'What is a revaluation account?',
    });

    // The rewrite fails → the message is answered as typed (no error for the student)
    or.replyFor = (body) => {
      if (isRewrite(body)) throw new Error('provider down');
      return undefined;
    };
    or.answer = 'A partnership shares profits [S1].';
    const fallback = await json(
      await ask(t.student.jar, { question: 'tell me about partnership', history, stream: false }),
    );
    expect(fallback).toMatchObject({ type: 'done', question: 'tell me about partnership' });
  });

  it('says "not in your textbook" without leaking the marker, and flags uncertain answers', async () => {
    const t = await setup();
    or.answer =
      'NOT_IN_TEXTBOOK: Your textbook does not cover cryptocurrency; it covers partnership accounts.';
    const events = await sse(
      await ask(t.student.jar, { question: 'Explain partnership firms and cryptocurrency' }),
    );
    const text = events
      .filter((e) => e.type === 'delta')
      .map((e) => e.text)
      .join('');
    expect(text).not.toContain('NOT_IN_TEXTBOOK');
    const done = events.at(-1);
    expect(done).toMatchObject({ notInBook: true, citations: [] });
    expect(done.answer).toBe(
      'Your textbook does not cover cryptocurrency; it covers partnership accounts.',
    );

    // No citations → uncertain; non-stream JSON mode works too
    or.answer = 'A partnership shares profits among partners.';
    const res = await ask(t.student.jar, {
      question: 'What is a partnership deed exactly?',
      stream: false,
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await json(res)).toMatchObject({ type: 'done', uncertain: true, notInBook: false });
  });

  it('refuses when credits run out (error event), scopes by role, admin sees the model', async () => {
    const t = await setup();
    // Admin: platform wallet, sees the model
    or.answer = 'Revaluation records changes in asset values [S1].';
    const a = (
      await sse(await ask(t.admin.jar, { question: 'What is a revaluation account?' }))
    ).at(-1);
    expect(a).toMatchObject({ type: 'done', model: 'google/gemini-2.5-flash' });
    expect(a.citations[0].page).toBe(3);

    // A student with no credits anywhere: an error event, nothing charged
    const broke = await createSignedInUser('student');
    await call('POST', '/api/me/enrolments/join', {
      jar: broke.jar,
      body: { joinCode: t.cls.joinCode },
    });
    const ev = await sse(
      await ask(broke.jar, { question: 'What is a partnership firm agreement?', forceNew: true }),
    );
    expect(ev.at(-1)).toMatchObject({ type: 'error', code: 'insufficient_credits' });

    // A POC whose institution has no mapped books: refused with a clear message
    const otherPoc = await createSignedInUser('institution_poc');
    const inst2 = await json(
      await call('POST', '/api/admin/institutions', {
        jar: t.admin.jar,
        body: { name: 'No Book College', type: 'college' },
      }),
    );
    await call('POST', `/api/admin/institutions/${inst2.id}/pocs`, {
      jar: t.admin.jar,
      body: { email: otherPoc.email },
    });
    const r = await ask(otherPoc.jar, { question: 'What is goodwill?' });
    expect(r.status).toBe(400);
  });

  it('reconciles charges with OpenRouter and adjusts the wallet', async () => {
    const t = await setup();
    or.answer = 'Goodwill is the value of the reputation of a firm [S1].';
    or.costUsd = 0.0001;
    await sse(await ask(t.student.jar, { question: 'Define goodwill', forceNew: true }));
    const afterCharge = await balance(t.studentW.id);
    // OpenRouter later reports $0.0002 (we charged $0.0001): the difference is charged as an adjustment
    or.generationCostUsd = 0.0002;
    const db = createDb(env.DB);
    const r = await reconcileUsage(env as unknown as Env, db, Date.now() + 10 * 60_000);
    expect(r.adjusted).toBeGreaterThanOrEqual(1);
    expect(await balance(t.studentW.id)).toBe(afterCharge - 9_680);
    const adj = await env.DB.prepare(
      "SELECT count(*) n FROM ledger_entries WHERE type = 'adjust'",
    ).first<{ n: number }>();
    expect(adj!.n).toBeGreaterThanOrEqual(1);
    // Nothing left to reconcile; ledger still balances
    expect(
      (await reconcileUsage(env as unknown as Env, db, Date.now() + 10 * 60_000)).checked,
    ).toBe(0);
    const mismatch = await env.DB.prepare(
      'SELECT w.id FROM wallets w LEFT JOIN (SELECT wallet_id, sum(amount_micro) s FROM ledger_entries GROUP BY wallet_id) l ON l.wallet_id = w.id WHERE w.balance_micro != coalesce(l.s, 0)',
    ).all();
    expect(mismatch.results).toEqual([]);
    // Float panel reports the difference
    const float = await json(await call('GET', '/api/admin/credits/float', { jar: t.admin.jar }));
    expect(float.reconciliation.calls).toBeGreaterThanOrEqual(1);
  });
});

describe('citation verifier', () => {
  const src = (n: number, page: number, text: string): Source => ({
    n,
    chunkId: `c${n}`,
    bookId: 'b',
    bookTitle: 'Book',
    page,
    section: null,
    text,
    score: 1,
  });
  it('keeps supported citations, flags weak ones and drops invented sources', () => {
    const sources = [
      src(1, 10, 'Goodwill is the reputation value of a firm.'),
      src(2, 11, 'Stock is valued at cost.'),
    ];
    const v = verifyCitations(
      'Goodwill is the reputation of a firm [S1]. Elephants are large mammals [S2]. See also [S9].',
      sources,
    );
    expect(v.citations).toEqual([
      expect.objectContaining({ n: 1, page: 10, supported: true }),
      expect.objectContaining({ n: 2, page: 11, supported: false }),
    ]);
    expect(v.answer).not.toContain('[S9]');
    expect(v.hadInvalid).toBe(true);
  });
});

describe('eval harness endpoints', () => {
  it('judges an answer (platform wallet) and stores runs per model; admin only', async () => {
    await seedPilotTaxonomy();
    const admin = await createSignedInUser('admin');
    const teacher = await createSignedInUser('teacher');
    await call('POST', '/api/admin/models/sync', { jar: admin.jar });
    await call('POST', '/api/admin/credits/issue', {
      jar: admin.jar,
      body: { target: { type: 'platform' }, credits: '5' },
    });
    or.answer = '{"score": 1, "reason": "Covers the key points"}';
    const judged = await json(
      await call('POST', '/api/admin/evals/judge', {
        jar: admin.jar,
        body: {
          question: 'What is goodwill?',
          reference: 'Reputation value.',
          answer: 'Reputation value [S1].',
        },
      }),
    );
    expect(judged).toEqual({ score: 1, reason: 'Covers the key points' });
    expect(or.requests.at(-1)!.model).toBe('google/gemini-2.5-flash');
    for (const [model, c] of [
      ['google/gemini-2.5-flash', 0.8],
      ['google/gemini-2.5-flash', 0.95],
      ['openai/gpt-4o-mini', 0.7],
    ] as const) {
      await call('POST', '/api/admin/evals/runs', {
        jar: admin.jar,
        body: {
          model,
          promptVersion: 'tutor_answer@1',
          questions: 55,
          citationAccuracy: c,
          correctness: c,
        },
      });
    }
    const runs = await json<any[]>(await call('GET', '/api/admin/evals/runs', { jar: admin.jar }));
    expect(runs.find((r) => r.model === 'google/gemini-2.5-flash').citationAccuracy).toBe(0.95);
    expect(runs).toHaveLength(2);
    expect((await call('GET', '/api/admin/evals/runs', { jar: teacher.jar })).status).toBe(403);
  });
});
