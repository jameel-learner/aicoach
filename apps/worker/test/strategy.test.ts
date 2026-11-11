import { env } from 'cloudflare:workers';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blueprintChecks, type StructureExtract } from '@aicoach/core';
import { testVectors } from '../src/content/store';
import { clearRegistryCache } from '../src/llm/registry';
import { normQno, normSplit, tidy } from '../src/strategy/compile';
import { call, createSignedInUser, json, seedPilotTaxonomy, type Jar } from './helpers';
import { installOpenRouterMock, type MockState } from './openrouter-mock';

/** Phase 3: board material → tagged questions → ExamStrategy draft → Admin approval. */

const TABLES = [
  'board_items',
  'exam_strategies',
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

/** A small but consistent pattern: 3 chapters, 4 parts. */
const STRUCTURE: StructureExtract = {
  academicYear: '2026-27',
  durationMin: 180,
  readingTimeMin: 15,
  maxMarks: 26,
  questionsOnPaper: 10,
  parts: [
    {
      part: 'A',
      marksEach: 1,
      asked: 6,
      toAnswer: 6,
      typology: ['MCQ'],
      chapters: [1, 2, 3],
      instructions: [],
    },
    {
      part: 'B',
      marksEach: 2,
      asked: 2,
      toAnswer: 1,
      typology: [],
      chapters: [1, 3],
      instructions: [],
    },
    {
      part: 'C',
      marksEach: 6,
      asked: 1,
      toAnswer: 1,
      typology: [],
      chapters: [1],
      instructions: [],
    },
    {
      part: 'D',
      marksEach: 12,
      asked: 2,
      toAnswer: 1,
      typology: [],
      chapters: [2, 3],
      instructions: [],
    },
  ],
  chapters: [
    {
      no: 1,
      title: 'Partnership basics',
      hours: 8,
      marks: 10,
      partA: 2,
      partB: 1,
      partC: 1,
      partD: 0,
      note: null,
    },
    {
      no: 2,
      title: 'Admission',
      hours: 10,
      marks: 14,
      partA: 2,
      partB: 0,
      partC: 0,
      partD: 1,
      note: null,
    },
    {
      no: 3,
      title: 'Retirement',
      hours: 10,
      marks: 16,
      partA: 2,
      partB: 1,
      partC: 0,
      partD: 1,
      note: null,
    },
  ],
  problemSpecs: [{ chapter: 1, part: 'C', allowed: ['P&L Appropriation A/c (5 items)'] }],
  notes: ['If 12 marks is on admission, 6 marks is on retirement'],
};

function reply(body: { messages?: { role: string; content: unknown }[] }) {
  const system = String(body.messages?.[0]?.content ?? '');
  const user = String(body.messages?.at(-1)?.content ?? '');
  if (system.startsWith('You read official board-exam documents')) return JSON.stringify(STRUCTURE);
  if (system.startsWith('You tag every question of one board-exam question paper'))
    return JSON.stringify({
      questions: [
        {
          qno: '1',
          part: 'A',
          marks: 1,
          chapter: 1,
          topic: 'Partnership deed',
          typology: 'mcq',
          text: 'Deed?',
          page: 1,
        },
        {
          qno: '2',
          part: 'A',
          marks: 1,
          chapter: 2,
          topic: 'Sacrificing ratio',
          typology: 'mcq',
          text: 'SR?',
          page: 1,
        },
        {
          qno: '3.',
          part: 'B',
          marks: 2,
          chapter: 1,
          topic: 'Fixed vs fluctuating capital',
          typology: 'short_answer',
          text: 'Differences',
          page: 1,
        },
        {
          qno: '4',
          part: 'B',
          marks: 2,
          chapter: 3,
          topic: 'Gaining ratio',
          typology: 'short_answer',
          text: 'GR',
          page: 2,
        },
        {
          qno: '5',
          part: 'C',
          marks: 6,
          chapter: 1,
          topic: 'P&L Appropriation account',
          typology: 'problem',
          text: 'Prepare P&L App',
          page: 2,
        },
        {
          qno: '6',
          part: 'D',
          marks: 12,
          chapter: 2,
          topic: 'Admission with goodwill',
          typology: 'problem',
          text: 'Admission problem',
          page: 2,
        },
        {
          qno: '7',
          part: 'D',
          marks: 12,
          chapter: 3,
          topic: 'Retirement balance sheet',
          typology: 'problem',
          text: 'Retirement problem',
          page: 2,
        },
      ],
      endsIn: null,
    });
  if (
    system.startsWith(
      "You tag the questions on a run of pages from a board's official question bank",
    )
  ) {
    // First window (pages 6-7): chapter-wise bank, then the start of an embedded 2024 exam paper.
    const page = Number(/--- page (\d+) ---/.exec(user)?.[1] ?? 6);
    return JSON.stringify({
      questions: [
        {
          qno: '1',
          part: 'A',
          marks: 1,
          chapter: 1,
          topic: 'Partnership deed contents',
          typology: 'mcq',
          difficulty: 'easy',
          text: 'Contents of deed',
          page,
          source: 'bank',
        },
        {
          qno: '2',
          part: 'C',
          marks: 6,
          chapter: 1,
          topic: 'Interest on drawings',
          typology: 'problem',
          difficulty: 'hots',
          text: 'IOD product method',
          page,
          source: 'bank',
        },
        {
          qno: '27',
          part: 'D',
          marks: 12,
          chapter: 2,
          topic: 'Admission – goodwill premium',
          typology: 'problem',
          text: 'Admission',
          page: page + 1,
          source: 'board_exam',
          paperLabel: 'A1-2024',
          examYear: 2024,
        },
      ],
      endsIn: 'paper A1-2024, Part D',
    });
  }
  if (system.startsWith('You read an official scheme of evaluation'))
    return JSON.stringify({
      answers: [
        {
          qno: '5',
          answer: 'P&L Appropriation with 6 items',
          markSplit: 'each item 1 mark: 6x1=6',
          markingPoints: [{ point: 'Interest on capital', marks: 1 }],
        },
        {
          qno: '3',
          answer: 'Two differences',
          markSplit: '1+1',
          markingPoints: [],
          note: 'or any other two differences',
        },
        { qno: '99', answer: 'not in the paper', markSplit: null },
      ],
    });
  if (system.startsWith('You study full-marks (centum) board-exam answer scripts'))
    return JSON.stringify({
      conventions: [
        {
          format: 'journal_entry',
          rule: 'Narration in brackets starting with Being',
          example: null,
          source: 'script 1',
        },
      ],
    });
  if (system.startsWith('You merge question topics of one chapter')) {
    const ids = [...user.matchAll(/^(i\d+) \|/gm)].map((m) => m[1]!);
    // Chapter 2: "Admission with goodwill" (exam) and "Admission – goodwill premium" (2024 exam) merge.
    return JSON.stringify({ topics: [{ name: 'Canonical topic', items: ids }] });
  }
  return undefined;
}

async function makePdf(pages: number) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

async function addDoc(
  jar: Jar,
  offeringId: string,
  title: string,
  category: string,
  pages: number,
  extra: Record<string, string> = {},
) {
  const form = new FormData();
  form.set('file', new File([await makePdf(pages)], 'doc.pdf', { type: 'application/pdf' }));
  form.set('title', title);
  form.set('offeringId', offeringId);
  form.set('kind', 'board_material');
  form.set('category', category);
  form.set('academicYear', '2025-26');
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  const { id } = await json(await call('POST', '/api/admin/books', { jar, multipart: form }));
  await call('POST', `/api/admin/books/${id}/parse`, { jar, body: {} });
  await call('POST', `/api/admin/books/${id}/publish`, { jar, body: {} });
  return id as string;
}

async function setupBoard() {
  const offeringId = await seedPilotTaxonomy();
  const admin = await createSignedInUser('admin');
  await call('POST', '/api/admin/models/sync', { jar: admin.jar });
  await call('POST', '/api/admin/credits/issue', {
    jar: admin.jar,
    body: { target: { type: 'platform' }, credits: '50' },
  });
  or.parseText = (f) =>
    `## Text of ${f}\n\nSome question text on this page, long enough to pass the checks.`;
  or.answer = '### Q1\n\nA transcribed answer';
  await addDoc(admin.jar, offeringId, 'Blueprint 2026-27', 'blueprint', 1);
  const paper = await addDoc(
    admin.jar,
    offeringId,
    'Board paper 2025-26 · EXAM1_2026',
    'board_paper',
    2,
  );
  await addDoc(admin.jar, offeringId, 'Scheme 2025-26 · EXAM1_2026_Answers', 'scheme', 1, {
    relatedBookId: paper,
  });
  await addDoc(admin.jar, offeringId, 'Question bank 2025-26', 'question_bank', 7);
  await addDoc(admin.jar, offeringId, 'Centum script 1', 'answer_script', 1);
  or.replyFor = reply;
  return { offeringId, admin };
}

describe('exam strategy', () => {
  it('blueprint arithmetic proves the pattern matches the blueprint', () => {
    expect(blueprintChecks(STRUCTURE).every((c) => c.ok)).toBe(true);
    const broken = structuredClone(STRUCTURE);
    broken.chapters[0]!.marks = 11;
    const failed = blueprintChecks(broken)
      .filter((c) => !c.ok)
      .map((c) => c.name);
    expect(failed).toEqual([
      'Chapter marks add up to the marks on the paper',
      "Each chapter's marks equal its questions × marks",
    ]);
  });

  it('cleans OCR table dividers and question numbers', () => {
    expect(tidy(`| a |\n| :${'-'.repeat(5000)} |`)).toBe('| a |\n| :--- |');
    expect(['22.', 'Q22', '22)', ' 7 '].map(normQno)).toEqual(['22', '22', '22', '7']);
  });

  it('compiles a draft from board material, merges schemes and topics, then the Admin approves', async () => {
    const { offeringId, admin } = await setupBoard();
    const teacher = await createSignedInUser('teacher');
    expect(
      (
        await call('POST', '/api/admin/strategy/compile', {
          jar: teacher.jar,
          body: { offeringId },
        })
      ).status,
    ).toBe(403);

    const before = or.requests.length;
    const res = await call('POST', '/api/admin/strategy/compile', {
      jar: admin.jar,
      body: { offeringId },
    });
    expect(res.status).toBe(202);
    const { id, version } = await json(res);
    expect(version).toBe(1);
    // structure 1 + paper 1 + bank 1 window (pages 6-7) + scheme 1 + conventions 1 + topics 3
    expect(or.requests.length - before).toBe(8);

    const run = await json(await call('GET', `/api/admin/strategy/${id}`, { jar: admin.jar }));
    expect(run.status).toBe('draft');
    expect(run.costUsdNano).toBeGreaterThan(0);
    const s = run.strategy;
    expect(s).toMatchObject({
      schema: 'exam_strategy@1',
      board: 'KSEAB',
      maxMarks: 26,
      minutesPerMark: 6.92,
      // The one-question "A1-2024" from the bank is a note on a bank question, not a paper
      exams: { papers: 1, years: [2026] },
      modelPapers: 0,
    });
    expect(s.checks.filter((c: any) => !c.ok)).toEqual([]);
    expect(s.parts.find((p: any) => p.part === 'D')).toMatchObject({
      marksOnPaper: 24,
      marksToAnswer: 12,
      minutesPerQuestion: 83.1,
    });
    // Chapter 2: both admission questions merged into one topic, asked in 2 board papers
    const ch2 = s.chapters.find((c: any) => c.no === 2);
    expect(ch2.topics[0]).toMatchObject({
      name: 'Canonical topic',
      examPapers: 1,
      examYears: [2026],
      bankItems: 1,
    });
    expect(s.chapters.find((c: any) => c.no === 1).problemSpecs).toEqual([
      { part: 'C', allowed: ['P&L Appropriation A/c (5 items)'] },
    ]);
    expect(s.answerConventions).toHaveLength(1);
    expect(s.difficulty).toEqual({ easy: 1, hots: 1 });
    expect(s.priorities[0]).toMatch(
      /^Part D \(12 marks each\) is 46% of the marks and you choose 1 of 2/,
    );
    expect(s.stats).toMatchObject({ questions: 10, withMarking: 2, bankItems: 3, examItems: 7 });

    // Scheme answers merged into the paper's questions by question number ("3." → "3")
    const items = await json<any[]>(
      await call('GET', `/api/admin/strategy/${id}/items?part=B`, { jar: admin.jar }),
    );
    const q3 = items.find((i) => i.qno === '3');
    expect(q3).toMatchObject({
      markSplit: '1+1',
      answer: 'Two differences\n(or any other two differences)',
    });
    const bank = await json<any[]>(
      await call('GET', `/api/admin/strategy/${id}/items?source=bank`, { jar: admin.jar }),
    );
    // Two chapter-wise questions + the folded "A1-2024" one (no difficulty label)
    expect(bank.map((i) => i.difficulty).sort()).toEqual(['easy', 'hots', null]);

    // Continuing a run skips finished (paid) steps
    await env.DB.prepare("UPDATE exam_strategies SET status = 'failed' WHERE id = ?")
      .bind(id)
      .run();
    const n = or.requests.length;
    expect(
      (await call('POST', `/api/admin/strategy/${id}/continue`, { jar: admin.jar, body: {} }))
        .status,
    ).toBe(202);
    expect(or.requests.length).toBe(n);
    expect(
      (await json(await call('GET', `/api/admin/strategy/${id}`, { jar: admin.jar }))).status,
    ).toBe('draft');

    // Approve; a second approved version supersedes the first
    expect(
      (
        await call('POST', `/api/admin/strategy/${id}/approve`, {
          jar: admin.jar,
          body: { note: 'ok' },
        })
      ).status,
    ).toBe(200);
    const second = await json(
      await call('POST', '/api/admin/strategy/compile', { jar: admin.jar, body: { offeringId } }),
    );
    expect(second.version).toBe(2);
    await call('POST', `/api/admin/strategy/${second.id}/approve`, { jar: admin.jar, body: {} });
    const list = await json(
      await call('GET', `/api/admin/strategy?offeringId=${offeringId}`, { jar: admin.jar }),
    );
    expect(list.runs.map((r: any) => [r.version, r.status])).toEqual([
      [2, 'approved'],
      [1, 'superseded'],
    ]);
    expect(list.documents).toHaveLength(5);
    expect(list.estimate.usd).toBeGreaterThan(0);
  });

  it('lets the Admin correct what pages are, then reassembles for free', async () => {
    const { offeringId, admin } = await setupBoard();
    const { id } = await json(
      await call('POST', '/api/admin/strategy/compile', { jar: admin.jar, body: { offeringId } }),
    );
    const papers = await json<any[]>(
      await call('GET', `/api/admin/strategy/${id}/papers`, { jar: admin.jar }),
    );
    const exam = papers.find((p) => p.source === 'board_exam');
    expect(exam).toMatchObject({ paperLabel: 'EXAM1_2026', questions: 7, fromPage: 1, toPage: 2 });
    const path = `/api/admin/strategy/${id}/relabel`;
    // A board exam needs a year; a paper needs a name
    expect(
      (
        await call('POST', path, {
          jar: admin.jar,
          body: {
            bookId: exam.bookId,
            fromPage: 1,
            toPage: 2,
            source: 'board_exam',
            paperLabel: 'X',
          },
        })
      ).status,
    ).toBe(400);
    const res = await call('POST', path, {
      jar: admin.jar,
      body: {
        bookId: exam.bookId,
        fromPage: 1,
        toPage: 2,
        source: 'practice_paper',
        paperLabel: 'Practice A',
      },
    });
    expect(await json(res)).toEqual({ questions: 7 });
    const n = or.requests.length;
    expect(
      (await call('POST', `/api/admin/strategy/${id}/reassemble`, { jar: admin.jar, body: {} }))
        .status,
    ).toBe(200);
    expect(or.requests.length).toBe(n); // no model calls
    const run = await json(await call('GET', `/api/admin/strategy/${id}`, { jar: admin.jar }));
    expect(run.strategy.exams).toMatchObject({ papers: 0 });
    // Once approved, a version can't be changed any more
    await call('POST', `/api/admin/strategy/${id}/approve`, { jar: admin.jar, body: {} });
    expect(
      (await call('POST', `/api/admin/strategy/${id}/reassemble`, { jar: admin.jar, body: {} }))
        .status,
    ).toBe(409);
  });

  it('groups marks allotments written differently', () => {
    expect(
      [
        '01',
        '1',
        'each item 1 mark: 6X1=6',
        'each item 1 mark:6x1 = 6',
        '(4+1+1)=6',
        '4 + 1 + 1 = 6',
      ].map(normSplit),
    ).toEqual(['1', '1', 'each item 1 mark:6×1=6', 'each item 1 mark:6×1=6', '4+1+1=6', '4+1+1=6']);
  });

  it('stops with a clear message when the platform wallet is empty, and can be continued', async () => {
    const { offeringId, admin } = await setupBoard();
    await env.DB.prepare(
      "UPDATE wallets SET balance_micro = 0 WHERE owner_type = 'platform'",
    ).run();
    const { id } = await json(
      await call('POST', '/api/admin/strategy/compile', { jar: admin.jar, body: { offeringId } }),
    );
    const run = await json(await call('GET', `/api/admin/strategy/${id}`, { jar: admin.jar }));
    expect(run).toMatchObject({ status: 'failed' });
    expect(run.statusMessage).toMatch(/platform wallet ran out of credits/);
    // Only one compile at a time per subject — but a failed one doesn't block
    expect(
      (await call('POST', '/api/admin/strategy/compile', { jar: admin.jar, body: { offeringId } }))
        .status,
    ).toBe(202);
  });
});
