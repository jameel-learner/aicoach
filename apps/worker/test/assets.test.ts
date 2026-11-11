import { env } from 'cloudflare:workers';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { examBudget, type ExamStrategy, type NoteDraft } from '@aicoach/core';
import { cellNumber, noteChecks, splitTotal, tallyProblems } from '../src/assets/checks';
import { planSlots } from '../src/assets/generate';
import { testVectors } from '../src/content/store';
import { clearRegistryCache } from '../src/llm/registry';
import { reasoningFor } from '../src/llm/run';
import { call, createSignedInUser, json, seedPilotTaxonomy } from './helpers';
import { installOpenRouterMock, type MockState } from './openrouter-mock';

/** Phase 3: learning material (notes) from the approved strategy, decision 9.5-4. */

const TABLES = [
  'asset_reviews',
  'learning_assets',
  'generation_runs',
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

describe('code checks (model-independent)', () => {
  it('reads Indian-grouped amounts and brackets', () => {
    expect(['1,27,300', '₹ 8,000', '(30,000)', 'Rent', ''].map(cellNumber)).toEqual([
      127300,
      8000,
      -30000,
      null,
      null,
    ]);
  });

  it('finds accounts that do not tally, also with several partner columns', () => {
    const ok = `| Particulars | ₹ | Particulars | ₹ |\n| --- | --- | --- | --- |\n| To Rent | 6,000 | By Profit | 56,000 |\n| Total | 56,000 | Total | 56,000 |`;
    const partners = `| Particulars | A | B | Particulars | A | B |\n| --- | --- | --- | --- | --- | --- |\n| Total | 1,15,500 | 48,500 | Total | 1,15,500 | 48,500 |`;
    const bad = `| Dr | ₹ | Cr | ₹ |\n|---|---|---|---|\n| Total | 56,000 | Total | 55,000 |`;
    const bs = `| Particulars | 2025 |\n|---|---|\n| Total equity and liabilities | 14,50,000 |\n| Total assets | 14,00,000 |`;
    expect(tallyProblems(ok)).toEqual([]);
    expect(tallyProblems(partners)).toEqual([]);
    expect(tallyProblems(bad)).toEqual(["Totals don't tally: 56000 vs 55000"]);
    expect(tallyProblems(bs)).toEqual(["Balance sheet doesn't balance: 1450000 vs 1400000"]);
  });

  it('adds up marks allotments the way schemes write them', () => {
    expect(
      ['1+2+2+1=6', 'each item 1 mark: 6x1=6', '4+1+1', '3 × 4', 'see scheme'].map(splitTotal),
    ).toEqual([6, 6, 6, 12, null]);
  });

  it('sizes the exam answer to the minutes the paper allows; the study part only has an upper limit', () => {
    expect(examBudget(6, 13.5)).toEqual({ minutes: 13.5, maxWords: 203 });
    expect(examBudget(12)).toEqual({ minutes: 27, maxWords: 405 });
    const note = (answer: string, study: string): NoteDraft => ({
      title: 'T',
      summary: 'S [S1]',
      sections: [{ heading: 'H', body: study }],
      examAnswer: { question: 'Q', answer, marksSplit: '1+1=2', minutes: 4.5 },
      keyTerms: [],
      examTips: [],
      whyThisMatters: { exam: 'e', realWorld: 'r' },
    });
    const budget = examBudget(2, 4.5); // 68 words
    const ok = noteChecks(note('word '.repeat(60), 'word '.repeat(150)), 2, 1, budget);
    expect(ok.every((c) => c.ok)).toBe(true);
    const long = noteChecks(note('word '.repeat(120), 'word '.repeat(400)), 2, 1, budget);
    expect(long.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      'Exam answer fits 4.5 min',
      'Study part not too long',
    ]);
  });

  it('maps "thinking off" per model (Claude 5 models get low effort)', () => {
    expect(reasoningFor('google/gemini-2.5-flash', 'off')).toEqual({ max_tokens: 0 });
    expect(reasoningFor('anthropic/claude-opus-5.5', 'off')).toEqual({ effort: 'low' });
    expect(reasoningFor('anthropic/claude-sonnet-5.5', 'off')).toEqual({ effort: 'low' });
  });
});

const STRATEGY = {
  schema: 'exam_strategy@1',
  board: 'KSEAB',
  className: '2nd PUC',
  subject: 'Accountancy',
  chapters: [
    {
      no: 1,
      title: 'Partnership basics',
      marks: 10,
      partA: 2,
      partB: 1,
      partC: 0,
      partD: 0,
      topics: [{ name: 'Partnership deed', marks: [1, 2], examPapers: 2, bankItems: 3 }],
      problemSpecs: [],
    },
    {
      no: 3,
      title: 'Retirement',
      marks: 30,
      partA: 1,
      partB: 0,
      partC: 1,
      partD: 0,
      topics: [
        { name: 'Gaining ratio', marks: [1, 6], examPapers: 4, bankItems: 2 },
        { name: 'Revaluation account', marks: [], examPapers: 0, bankItems: 1 },
      ],
      problemSpecs: [
        { part: 'C', allowed: ['Calculation of gaining ratio of continuing partners'] },
      ],
    },
  ],
  parts: [{ part: 'C', marksEach: 6, minutesPerQuestion: 10 }],
  answerConventions: [{ format: 'journal_entry', rule: 'Narration starting with Being' }],
} as unknown as ExamStrategy;

it('plans one note per topic × marks level (topics never asked get a 1-mark note)', () => {
  expect(planSlots(STRATEGY, null).map((s) => s.key)).toEqual([
    'note:1:partnership-deed:1',
    'note:1:partnership-deed:2',
    'note:3:gaining-ratio:1',
    'note:3:gaining-ratio:6',
    'note:3:revaluation-account:1',
  ]);
  expect(planSlots(STRATEGY, [3])).toHaveLength(3);
});

const TALLIED = `| Particulars | ₹ | Particulars | ₹ |\n| --- | --- | --- | --- |\n| To Balance c/d | 9,000 | By Cash | 9,000 |\n| Total | 9,000 | Total | 9,000 |`;
const UNTALLIED = TALLIED.replace(
  '| Total | 9,000 | Total | 9,000 |',
  '| Total | 9,000 | Total | 8,000 |',
);

function reply(body: { messages?: { role: string; content: unknown }[] }) {
  const system = String(body.messages?.[0]?.content ?? '');
  const user = String(body.messages?.at(-1)?.content ?? '');
  const marks = Number(/Marks level: (\d+) mark/.exec(user)?.[1] ?? 1);
  const topic = /Topic: (.+)/.exec(user)?.[1] ?? '';
  const note = (solution: string) =>
    JSON.stringify({
      title: topic,
      summary: `What to know about ${topic} [S1].`,
      sections: [
        {
          heading: 'Meaning',
          body: `${'The textbook explains this topic carefully. '.repeat(marks >= 6 ? 35 : 8)}[S1]`,
        },
      ],
      examAnswer:
        marks >= 6
          ? { question: 'A worked problem', answer: solution, marksSplit: '1+2+2+1=6', minutes: 10 }
          : { question: 'What is it?', answer: 'Gaining ratio', marksSplit: null, minutes: 2.3 },
      keyTerms: ['term'],
      examTips: ['Show working notes'],
      whyThisMatters: { exam: 'Asked often', realWorld: 'Firms do this' },
    });
  if (system.includes('You are given a draft and an examiner review'))
    return note(
      user.includes('reviewer (teacher)')
        ? `${TALLIED}

Shorter.`
        : TALLIED,
    );
  if (system.startsWith('You write exam-ready study notes')) return note(UNTALLIED);
  if (system.startsWith('You are a strict senior examiner')) {
    const bad = marks >= 6;
    return JSON.stringify({
      scores: { accuracy: bad ? 2 : 5, grounded: 5, marksFit: 5, presentation: 5, clarity: 5 },
      issues: bad
        ? [
            {
              severity: 'major',
              where: 'worked example',
              problem: 'Totals differ',
              fix: 'Recompute',
            },
          ]
        : [],
      verdict: bad ? 'fix' : 'pass',
    });
  }
  return undefined;
}

async function setup() {
  const offeringId = await seedPilotTaxonomy();
  const admin = await createSignedInUser('admin');
  await call('POST', '/api/admin/models/sync', { jar: admin.jar });
  await call('POST', '/api/admin/credits/issue', {
    jar: admin.jar,
    body: { target: { type: 'platform' }, credits: '50' },
  });
  // A published textbook to cite
  or.parseText = () =>
    '## 3.2 Gaining ratio\n\nGaining ratio is the ratio in which continuing partners acquire the share of the retiring partner. Partnership deed and revaluation account are also explained.';
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  const form = new FormData();
  form.set('file', new File([await doc.save()], 't.pdf', { type: 'application/pdf' }));
  form.set('title', 'NCERT Accountancy Part I');
  form.set('offeringId', offeringId);
  const { id: bookId } = await json(
    await call('POST', '/api/admin/books', { jar: admin.jar, multipart: form }),
  );
  await call('POST', `/api/admin/books/${bookId}/parse`, { jar: admin.jar, body: {} });
  await call('POST', `/api/admin/books/${bookId}/publish`, { jar: admin.jar, body: {} });
  or.replyFor = reply;
  return { offeringId, admin, bookId };
}

async function approveStrategy(offeringId: string, userId = 'u') {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO exam_strategies (id, offering_id, version, status, strategy, source_book_ids, prompt_version, created_by) VALUES (?, ?, 1, 'approved', ?, '[]', 'board_strategy@2', ?)",
  )
    .bind(id, offeringId, JSON.stringify(STRATEGY), userId)
    .run();
  return id;
}

describe('learning material: notes', () => {
  it('needs an approved strategy; Admin only', async () => {
    const { offeringId, admin } = await setup();
    const teacher = await createSignedInUser('teacher');
    expect(
      (await call('POST', '/api/admin/material/generate', { jar: admin.jar, body: { offeringId } }))
        .status,
    ).toBe(400);
    expect(
      (await call('GET', `/api/admin/material?offeringId=${offeringId}`, { jar: teacher.jar }))
        .status,
    ).toBe(403);
  });

  it('writes, critiques, fixes only when asked, checks, and versions notes in stable slots', async () => {
    const { offeringId, admin } = await setup();
    await approveStrategy(offeringId);
    const overview = await json(
      await call('GET', `/api/admin/material?offeringId=${offeringId}`, { jar: admin.jar }),
    );
    expect(overview.strategy).toMatchObject({ version: 1 });
    expect(overview.chapters.map((c: any) => [c.no, c.notes])).toEqual([
      [1, 2],
      [3, 3],
    ]);
    expect(overview.estimate).toMatchObject({
      writer: 'google/gemini-2.5-flash',
      critic: 'google/gemini-2.5-flash',
    });
    expect(overview.estimate.usd).toBeGreaterThan(0);

    // Generate chapter 3 only: 3 notes = 3 writer + 3 critic calls + 1 fixer (the 6-mark note)
    const before = or.requests.length;
    const res = await call('POST', '/api/admin/material/generate', {
      jar: admin.jar,
      body: { offeringId, chapters: [3] },
    });
    expect(res.status).toBe(202);
    const { id: runId } = await json(res);
    expect(or.requests.length - before).toBe(7);

    const list = await json<any[]>(
      await call('GET', `/api/admin/material/assets?offeringId=${offeringId}`, { jar: admin.jar }),
    );
    expect(list.map((a) => [a.slotKey, a.version, a.status, a.fixed])).toEqual([
      ['note:3:gaining-ratio:1', 1, 'draft', false],
      ['note:3:gaining-ratio:6', 1, 'draft', true],
      ['note:3:revaluation-account:1', 1, 'draft', false],
    ]);
    const six = await json(
      await call('GET', `/api/admin/material/assets/${list[1].id}`, { jar: admin.jar }),
    );
    expect(six.generator).toBe('google/gemini-2.5-flash|google/gemini-2.5-flash|note@2');
    // The fixer's version (tallied) was kept; the critic's scores of the draft are shown
    expect(six.content.examAnswer.answer).toContain('| Total | 9,000 | Total | 9,000 |');
    expect(six.critique).toMatchObject({ verdict: 'fix', fixedAfter: true });
    expect(Object.fromEntries(six.checks.map((c: any) => [c.name, c.ok]))).toMatchObject({
      'Cites the textbook': true,
      'Exam answer fits 10 min': true,
      'Study part not too long': true,
      'Accounts and statements tally': true,
      'Marks allotment adds up': true,
    });
    expect(six.sources[0]).toMatchObject({ bookTitle: 'NCERT Accountancy Part I', page: 1 });

    // Continuing a run skips notes already written
    await env.DB.prepare("UPDATE generation_runs SET status = 'failed' WHERE id = ?")
      .bind(runId)
      .run();
    const n = or.requests.length;
    await call('POST', `/api/admin/material/runs/${runId}/continue`, { jar: admin.jar, body: {} });
    expect(or.requests.length).toBe(n);

    // Review: a rejection needs a reason; approval records the reviewer's score
    const path = (id: string) => `/api/admin/material/assets/${id}/review`;
    expect(
      (await call('POST', path(list[0].id), { jar: admin.jar, body: { decision: 'reject' } }))
        .status,
    ).toBe(400);
    await call('POST', path(list[0].id), {
      jar: admin.jar,
      body: { decision: 'approve', score: 5 },
    });
    await call('POST', path(list[2].id), {
      jar: admin.jar,
      body: { decision: 'reject', note: 'Too thin' },
    });

    // Regenerating keeps the slots: new draft v2 next to approved v1; approving v2 supersedes v1
    await call('POST', '/api/admin/material/generate', {
      jar: admin.jar,
      body: { offeringId, chapters: [3] },
    });
    const v2 = await json<any[]>(
      await call('GET', `/api/admin/material/assets?offeringId=${offeringId}&chapter=3`, {
        jar: admin.jar,
      }),
    );
    const gaining1 = v2.filter((a) => a.slotKey === 'note:3:gaining-ratio:1');
    expect(gaining1.map((a) => [a.version, a.status])).toEqual([
      [1, 'approved'],
      [2, 'draft'],
    ]);
    await call('POST', path(gaining1[1].id), {
      jar: admin.jar,
      body: { decision: 'approve', score: 4 },
    });
    const rows = await env.DB.prepare(
      "SELECT version, status FROM learning_assets WHERE slot_key = 'note:3:gaining-ratio:1' ORDER BY version",
    ).all<{ version: number; status: string }>();
    expect(rows.results).toEqual([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'approved' },
    ]);
    // Older versions stay viewable for comparison (e.g. Gemini vs Claude), newest first
    const versions = await json<any[]>(
      await call('GET', `/api/admin/material/assets/${gaining1[0].id}/versions`, {
        jar: admin.jar,
      }),
    );
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'approved'],
      [1, 'superseded'],
    ]);
    const old = await json<any>(
      await call('GET', `/api/admin/material/assets/${versions[1].id}`, { jar: admin.jar }),
    );
    expect(old.content.title).toBeTruthy();
    const summary = await json(
      await call('GET', `/api/admin/material/review-summary?offeringId=${offeringId}`, {
        jar: admin.jar,
      }),
    );
    expect(summary).toMatchObject({ reviewed: 2, averageScore: 4.5 });

    // Rewrite with my comment: fixer (with the comment) + critic; the draft becomes rejected
    const draft6 = v2.find((a) => a.slotKey === 'note:3:gaining-ratio:6');
    expect(draft6.version).toBe(2);
    const calls = or.requests.length;
    const rw = await call('POST', `/api/admin/material/assets/${draft6.id}/rewrite`, {
      jar: admin.jar,
      body: { note: 'Too long: keep the exam answer within the time' },
    });
    expect(rw.status).toBe(201);
    expect(or.requests.length - calls).toBe(2);
    const { id: newId } = await json(rw);
    const fresh = await json<any>(
      await call('GET', `/api/admin/material/assets/${newId}`, { jar: admin.jar }),
    );
    expect(fresh).toMatchObject({ version: 3, status: 'draft', fixed: true });
    expect(fresh.content.examAnswer.answer).toContain('Shorter.');
    const prev = await json<any>(
      await call('GET', `/api/admin/material/assets/${draft6.id}`, { jar: admin.jar }),
    );
    expect(prev).toMatchObject({
      status: 'rejected',
      reviewNote: 'Too long: keep the exam answer within the time',
    });
    // The list shows only the newest version of the slot; an older version can't be rewritten
    const after = await json<any[]>(
      await call('GET', `/api/admin/material/assets?offeringId=${offeringId}&chapter=3`, {
        jar: admin.jar,
      }),
    );
    expect(
      after.filter((a) => a.slotKey === 'note:3:gaining-ratio:6').map((a) => a.version),
    ).toEqual([3]);
    expect(
      (
        await call('POST', `/api/admin/material/assets/${draft6.id}/rewrite`, {
          jar: admin.jar,
          body: { note: 'again' },
        })
      ).status,
    ).toBe(409);
  });
});

describe('learning material: cards and memory maps', () => {
  const cardsReply = (body: { messages?: { role: string; content: unknown }[] }) => {
    const system = String(body.messages?.[0]?.content ?? '');
    const user = String(body.messages?.at(-1)?.content ?? '');
    const cards = (extra: string) =>
      JSON.stringify({
        title: 'Retirement',
        map: {
          center: 'Retirement of a partner',
          branches: [
            { label: 'Gaining ratio', topic: 'Gaining ratio', points: ['New minus old share'] },
            { label: 'Revaluation', topic: 'Revaluation account', points: ['Profit or loss'] },
          ],
        },
        cards: Array.from({ length: 8 }, (_, i) => ({
          topic: 'Gaining ratio',
          type: i === 0 ? 'formula' : 'definition',
          front: `Card ${i + 1}${extra}`,
          back: 'Gaining Ratio = New Ratio − Old Ratio',
          cite: 'S1',
        })),
      });
    if (system.startsWith('You make a memory map'))
      return system.includes('You are given a draft')
        ? cards(user.includes('reviewer (teacher)') ? ' (rewritten)' : '')
        : cards('');
    if (system.startsWith('You are a strict senior examiner reviewing revision cards'))
      return JSON.stringify({
        scores: { accuracy: 5, grounded: 5, marksFit: 4, presentation: 5, clarity: 5 },
        issues: [],
        verdict: 'pass',
      });
    return undefined;
  };

  it('writes one memory map + card set per chapter, checks topic coverage, rewrites on comment', async () => {
    const { offeringId, admin } = await setup();
    await approveStrategy(offeringId);
    or.replyFor = cardsReply;
    const overview = await json(
      await call('GET', `/api/admin/material?offeringId=${offeringId}`, { jar: admin.jar }),
    );
    expect(overview.chapters[1].cards).toMatchObject({ status: null, approved: false });
    expect(overview.chapters[1].cards.estimateUsd).toBeGreaterThan(0);

    const before = or.requests.length;
    const res = await call('POST', '/api/admin/material/generate', {
      jar: admin.jar,
      body: { offeringId, kind: 'cards', chapters: [3] },
    });
    expect(res.status).toBe(202);
    expect(or.requests.length - before).toBe(2); // writer + critic (passed, no fixer)

    const list = await json<any[]>(
      await call('GET', `/api/admin/material/assets?offeringId=${offeringId}&kind=cards`, {
        jar: admin.jar,
      }),
    );
    expect(list.map((a) => [a.slotKey, a.kind, a.topic, a.status])).toEqual([
      ['cards:3:retirement:0', 'cards', 'Retirement', 'draft'],
    ]);
    // Notes and cards are listed separately
    const notes = await json<any[]>(
      await call('GET', `/api/admin/material/assets?offeringId=${offeringId}`, { jar: admin.jar }),
    );
    expect(notes).toEqual([]);
    const one = await json<any>(
      await call('GET', `/api/admin/material/assets/${list[0].id}`, { jar: admin.jar }),
    );
    expect(one.generator).toBe('google/gemini-2.5-flash|google/gemini-2.5-flash|cards@1');
    const checks = Object.fromEntries(one.checks.map((c: any) => [c.name, c]));
    expect(checks['Number of cards'].ok).toBe(true);
    expect(checks['Every card cites the textbook'].ok).toBe(true);
    expect(checks['Cards are concise'].ok).toBe(true);
    expect(checks['Every topic has a card']).toMatchObject({
      ok: false,
      detail: 'no card for: Revaluation account',
    });
    expect(checks['Memory map fits one screen'].ok).toBe(true);

    const calls = or.requests.length;
    const rw = await call('POST', `/api/admin/material/assets/${list[0].id}/rewrite`, {
      jar: admin.jar,
      body: { note: 'Add a card on the revaluation account' },
    });
    expect(rw.status).toBe(201);
    expect(or.requests.length - calls).toBe(2);
    const fresh = await json<any>(
      await call('GET', `/api/admin/material/assets/${(await json(rw)).id}`, { jar: admin.jar }),
    );
    expect(fresh).toMatchObject({ kind: 'cards', version: 2, status: 'draft' });
    expect(fresh.content.cards[0].front).toContain('(rewritten)');
  });

  it('builds the subject-wise map from the strategy without a model call', async () => {
    const { offeringId, admin } = await setup();
    await approveStrategy(offeringId);
    const before = or.requests.length;
    const map = await json<any>(
      await call('GET', `/api/admin/material/subject-map?offeringId=${offeringId}`, {
        jar: admin.jar,
      }),
    );
    expect(or.requests.length).toBe(before);
    expect(map.subject).toBe('KSEAB 2nd PUC Accountancy');
    expect(map.chapters.map((c: any) => [c.no, c.marks, c.share, c.parts])).toEqual([
      [1, 10, 25, ['A', 'B']],
      [3, 30, 75, ['A', 'C']],
    ]);
    expect(map.chapters[1].topTopics[0]).toMatchObject({ name: 'Gaining ratio', examPapers: 4 });
  });
});

describe('learning material: our own question bank', () => {
  const PAST = 'What is meant by gaining ratio?';
  const q = (i: number, marks: number, over: Record<string, unknown> = {}) => ({
    topic: 'Gaining ratio',
    typology: marks === 1 ? (['mcq', 'fill_blank', 'very_short'] as const)[i % 3] : 'problem',
    difficulty: (['easy', 'average', 'hots'] as const)[i % 3],
    cognitive: 'apply',
    question: `New question number ${i} about gaining ratio at ${marks} marks`,
    options: marks === 1 && i % 3 === 0 ? ['(a) 1:1', '(b) 2:1', '(c) 3:1', '(d) 1:2'] : null,
    answer: marks === 1 && i % 3 === 0 ? '(b) 2:1' : marks >= 6 ? TALLIED : 'Gaining ratio',
    markingPoints:
      marks === 1
        ? []
        : [
            { point: 'Working', marks: marks - 1 },
            { point: 'Answer', marks: 1 },
          ],
    marksSplit: marks === 1 ? null : `${marks - 1}+1=${marks}`,
    cite: 'S1',
    ...over,
  });
  const reply = (body: { messages?: { role: string; content: unknown }[] }) => {
    const system = String(body.messages?.[0]?.content ?? '');
    const user = String(body.messages?.at(-1)?.content ?? '');
    const m = /Write (\d+) questions for Part (\w): (\d+) mark/.exec(user);
    const [count, marks] = [Number(m?.[1] ?? 3), Number(m?.[3] ?? 1)];
    if (system.startsWith('You write NEW board-exam questions')) {
      const qs = Array.from({ length: count }, (_, i) => q(i, marks));
      if (marks === 1) {
        qs[1] = q(1, 1, { question: qs[0]!.question }); // a duplicate of Q1
        qs[2] = q(2, 1, { question: PAST }); // a copy of a past board question
      }
      if (user.includes('reviewer (teacher)'))
        qs[0] = q(0, marks, { question: 'Rewritten question' });
      return JSON.stringify({ questions: qs });
    }
    if (system.startsWith('You are a strict senior examiner reviewing new exam questions'))
      return JSON.stringify({
        scores: { accuracy: 5, grounded: 5, marksFit: 5, presentation: 4, clarity: 5 },
        issues: [],
        verdict: 'pass',
      });
    return undefined;
  };

  it('writes question sets per chapter × marks level, removes duplicates, flags copies of past questions', async () => {
    const { offeringId, admin, bookId } = await setup();
    const strategyId = await approveStrategy(offeringId);
    await env.DB.prepare(
      "INSERT INTO board_items (id, strategy_id, book_id, source, paper_label, qno, part, marks, chapter, topic, typology, text) VALUES (?, ?, ?, 'board_exam', 'March 2024', '3', 'A', 1, 3, 'Gaining ratio', 'very_short', ?)",
    )
      .bind(crypto.randomUUID(), strategyId, bookId, PAST)
      .run();
    or.replyFor = reply;
    const overview = await json(
      await call('GET', `/api/admin/material?offeringId=${offeringId}`, { jar: admin.jar }),
    );
    expect(overview.chapters.map((c: any) => [c.no, c.questions.sets])).toEqual([
      [1, [1, 2]],
      [3, [1, 6]],
    ]);
    expect(overview.chapters[1].questions.estimateUsd).toBeGreaterThan(0);

    const before = or.requests.length;
    await call('POST', '/api/admin/material/generate', {
      jar: admin.jar,
      body: { offeringId, kind: 'questions', chapters: [3] },
    });
    expect(or.requests.length - before).toBe(4); // 2 sets × (writer + critic)
    const list = await json<any[]>(
      await call('GET', `/api/admin/material/assets?offeringId=${offeringId}&kind=questions`, {
        jar: admin.jar,
      }),
    );
    expect(list.map((a) => [a.slotKey, a.marks, a.kind])).toEqual([
      ['questions:3:retirement:1', 1, 'questions'],
      ['questions:3:retirement:6', 6, 'questions'],
    ]);
    const one = await json<any>(
      await call('GET', `/api/admin/material/assets/${list[0].id}`, { jar: admin.jar }),
    );
    expect(one.generator).toBe('google/gemini-2.5-flash|google/gemini-2.5-flash|questions@1');
    expect(one.content.questions).toHaveLength(9); // the duplicate was removed
    const checks = Object.fromEntries(one.checks.map((c: any) => [c.name, c]));
    expect(checks['No duplicates'].detail).toBe('removed 1 near-duplicate');
    expect(checks['Not copied from past papers']).toMatchObject({ ok: false });
    expect(checks['Not copied from past papers'].detail).toContain('Q2 ≈ March 2024 Q3');
    expect(checks['MCQs have 4 options and the answer names one'].ok).toBe(true);
    expect(checks['A mix of question types and difficulty'].ok).toBe(true);
    expect(checks['Every question cites the textbook'].ok).toBe(true);
    expect(checks['Number of questions'].ok).toBe(true);

    const six = await json<any>(
      await call('GET', `/api/admin/material/assets/${list[1].id}`, { jar: admin.jar }),
    );
    const sixChecks = Object.fromEntries(six.checks.map((c: any) => [c.name, c.ok]));
    expect(sixChecks).toMatchObject({
      'Number of questions': true,
      'Marking points add up': true,
      'Accounts and statements tally': true,
      'Answers fit 10 min': true,
    });

    // Rewrite with my comment
    const rw = await call('POST', `/api/admin/material/assets/${list[1].id}/rewrite`, {
      jar: admin.jar,
      body: { note: 'Use a three-partner firm' },
    });
    expect(rw.status).toBe(201);
    const fresh = await json<any>(
      await call('GET', `/api/admin/material/assets/${(await json(rw)).id}`, { jar: admin.jar }),
    );
    expect(fresh).toMatchObject({ kind: 'questions', version: 2, status: 'draft' });
    expect(fresh.content.questions[0].question).toBe('Rewritten question');
  });

  it('flags marking points that do not add up and MCQs without a named answer', async () => {
    const { questionChecks } = await import('../src/assets/questions');
    const set = {
      questions: [q(0, 1, { options: ['A', 'B', 'C'], answer: 'none' }), q(1, 1), q(2, 1), q(3, 1)],
    } as any;
    const six = { questions: [q(0, 6, { markingPoints: [{ point: 'x', marks: 4 }] })] } as any;
    const c1 = Object.fromEntries(
      questionChecks(
        set,
        { marks: 1, count: 4, exam: { minutes: 2.3, maxWords: 35 }, part: 'A' },
        1,
        {
          removed: [],
          copies: [],
        },
      ).map((c) => [c.name, c]),
    );
    expect(c1['MCQs have 4 options and the answer names one']).toMatchObject({
      ok: false,
      detail: 'Q1',
    });
    const c6 = Object.fromEntries(
      questionChecks(
        six,
        { marks: 6, count: 1, exam: { minutes: 13.5, maxWords: 203 }, part: 'C' },
        1,
        {
          removed: [],
          copies: [],
        },
      ).map((c) => [c.name, c]),
    );
    expect(c6['Marking points add up']).toMatchObject({ ok: false, detail: 'not 6 marks: Q1' });
  });
});

describe('concept graph, teacher review, learner access', () => {
  const graphReply = (body: { messages?: { role: string; content: unknown }[] }) => {
    const system = String(body.messages?.[0]?.content ?? '');
    if (system.startsWith('You map which topics a student must understand'))
      return JSON.stringify({
        edges: [
          { from: 'c1.1', to: 'c3.1', why: 'The deed fixes the profit-sharing ratio' },
          { from: 'c3.1', to: 'c3.2', why: 'Gaining ratio decides who pays' },
          { from: 'c3.2', to: 'c3.2', why: 'self' },
          { from: 'c9.9', to: 'c3.1', why: 'unknown topic' },
        ],
      });
    if (system.startsWith('You are a senior teacher reviewing a prerequisite map'))
      return JSON.stringify({
        scores: { accuracy: 5, grounded: 5, marksFit: 4, presentation: 5, clarity: 5 },
        issues: [],
        verdict: 'pass',
      });
    return reply(body);
  };
  const userId = async (email: string) =>
    (await env.DB.prepare('SELECT id FROM user WHERE email = ?')
      .bind(email)
      .first<{ id: string }>())!.id;
  const enrol = async (email: string, offeringId: string, role: 'student' | 'teacher') =>
    env.DB.prepare(
      "INSERT INTO enrolments (id, user_id, role_in, offering_id, status) VALUES (?, ?, ?, ?, 'active')",
    )
      .bind(crypto.randomUUID(), await userId(email), role, offeringId)
      .run();

  it('cleans and checks the concept graph', async () => {
    const { cleanEdges, graphChecks } = await import('../src/assets/graph');
    const { findCycle, graphNodes } = await import('@aicoach/core');
    const nodes = graphNodes(STRATEGY);
    expect(nodes.map((n) => n.id)).toEqual(['c1.1', 'c3.1', 'c3.2']);
    const { edges, dropped } = cleanEdges(
      {
        edges: [
          { from: 'c1.1', to: 'c3.1', why: 'a' },
          { from: 'c1.1', to: 'c3.1', why: 'repeat' },
          { from: 'x', to: 'c3.1', why: 'unknown' },
        ],
      },
      nodes,
    );
    expect([edges.length, dropped]).toEqual([1, 2]);
    expect(
      findCycle(
        ['a', 'b', 'c'],
        [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
          { from: 'c', to: 'a' },
        ],
      ),
    ).toEqual(['a', 'b', 'c', 'a']);
    const cyc = graphChecks(
      nodes,
      [
        { from: 'c3.1', to: 'c3.2', why: '' },
        { from: 'c3.2', to: 'c3.1', why: '' },
      ],
      0,
    );
    expect(cyc.find((c) => c.name === 'No cycles')).toMatchObject({
      ok: false,
      detail: 'Gaining ratio → Revaluation account → Gaining ratio',
    });
  });

  it('teachers of the subject score material; learners see only approved material of their subject', async () => {
    const { offeringId, admin } = await setup();
    await approveStrategy(offeringId);
    or.replyFor = graphReply;
    // Concept graph: one per subject
    await call('POST', '/api/admin/material/generate', {
      jar: admin.jar,
      body: { offeringId, kind: 'graph' },
    });
    const [graph] = await json<any[]>(
      await call('GET', `/api/admin/material/assets?offeringId=${offeringId}&kind=graph`, {
        jar: admin.jar,
      }),
    );
    expect(graph).toMatchObject({ slotKey: 'graph:0:kseab-2nd-puc-accountancy:0', chapter: 0 });
    const g = await json<any>(
      await call('GET', `/api/admin/material/assets/${graph.id}`, { jar: admin.jar }),
    );
    expect(g.content.edges.map((e: any) => `${e.from}>${e.to}`)).toEqual([
      'c1.1>c3.1',
      'c3.1>c3.2',
    ]);
    expect(g.checks.find((c: any) => c.name === 'Only known topics')).toMatchObject({ ok: false });
    // And notes for chapter 3
    await call('POST', '/api/admin/material/generate', {
      jar: admin.jar,
      body: { offeringId, chapters: [3] },
    });
    const notes = await json<any[]>(
      await call('GET', `/api/admin/material/assets?offeringId=${offeringId}`, { jar: admin.jar }),
    );

    // Teacher review: only teachers of the subject
    const teacher = await createSignedInUser('teacher', 'Ms Rao');
    const other = await createSignedInUser('teacher');
    await enrol(teacher.email, offeringId, 'teacher');
    expect(await json(await call('GET', '/api/review/offerings', { jar: other.jar }))).toEqual([]);
    const offerings = await json<any[]>(
      await call('GET', '/api/review/offerings', { jar: teacher.jar }),
    );
    expect(offerings.map((o) => o.id)).toEqual([offeringId]);
    const toReview = await json<any[]>(
      await call('GET', `/api/review/assets?offeringId=${offeringId}&chapter=3`, {
        jar: teacher.jar,
      }),
    );
    expect(toReview).toHaveLength(3);
    const put = (jar: any, id: string, body: unknown) =>
      call('PUT', `/api/review/assets/${id}`, { jar, body });
    expect((await put(other.jar, toReview[0].id, { score: 5 })).status).toBe(403);
    expect((await put(teacher.jar, toReview[0].id, { score: 3, comment: 'Thin' })).status).toBe(
      200,
    );
    expect((await put(teacher.jar, toReview[0].id, { score: 4 })).status).toBe(200); // replaces
    expect((await put(teacher.jar, toReview[1].id, { score: 5 })).status).toBe(200);
    const detail = await json<any>(
      await call('GET', `/api/review/assets/${toReview[0].id}`, { jar: teacher.jar }),
    );
    expect(detail.myReview).toMatchObject({ score: 4, comment: null });
    const relist = await json<any[]>(
      await call('GET', `/api/review/assets?offeringId=${offeringId}&chapter=3`, {
        jar: teacher.jar,
      }),
    );
    expect(relist.find((r) => r.id === toReview[0].id)).toMatchObject({ myScore: 4 });
    const adminView = await json<any>(
      await call('GET', `/api/admin/material/assets/${toReview[0].id}`, { jar: admin.jar }),
    );
    expect(adminView.reviews).toMatchObject([{ reviewer: 'Ms Rao', role: 'teacher', score: 4 }]);
    const summary = await json<any>(
      await call('GET', `/api/admin/material/review-summary?offeringId=${offeringId}`, {
        jar: admin.jar,
      }),
    );
    expect(summary.teachers).toEqual({ reviews: 2, assets: 2, teachers: 1, averageScore: 4.5 });

    // Learners: enrolled only, approved only
    const student = await createSignedInUser('student');
    const stranger = await createSignedInUser('student');
    await enrol(student.email, offeringId, 'student');
    expect((await call('GET', '/api/material', { jar: stranger.jar })).status).toBe(400);
    const before = await json<any>(await call('GET', '/api/material', { jar: student.jar }));
    expect(before).toMatchObject({ offeringId, ready: false });
    const approve = (id: string) =>
      call('POST', `/api/admin/material/assets/${id}/review`, {
        jar: admin.jar,
        body: { decision: 'approve', score: 4 },
      });
    const gaining6 = notes.find((n) => n.slotKey === 'note:3:gaining-ratio:6');
    await approve(gaining6.id);
    await approve(graph.id);
    const index = await json<any>(await call('GET', '/api/material', { jar: student.jar }));
    expect(index.ready).toBe(true);
    expect(index.stamp).toBeGreaterThan(0);
    expect(index.chapters.map((c: any) => [c.no, c.notes, c.cards])).toEqual([
      [1, 0, false],
      [3, 1, false],
    ]);
    const ch3 = await json<any>(
      await call('GET', '/api/material/chapters/3', { jar: student.jar }),
    );
    expect(ch3.notes.map((n: any) => [n.topic, n.marks])).toEqual([['Gaining ratio', 6]]);
    expect(ch3.notes[0].content.examAnswer.answer).toContain('| Total | 9,000 |');
    expect(ch3.prerequisites).toEqual({
      'Gaining ratio': [
        { topic: 'Partnership deed', chapter: 1, why: 'The deed fixes the profit-sharing ratio' },
      ],
      'Revaluation account': [
        { topic: 'Gaining ratio', chapter: 3, why: 'Gaining ratio decides who pays' },
      ],
    });
    expect((await call('GET', '/api/material/chapters/99', { jar: student.jar })).status).toBe(404);
  });
});

describe('moving approved material to another environment (decision 9.5-7)', () => {
  it('publishes approved material as a versioned package and imports it elsewhere', async () => {
    const { offeringId, admin, bookId } = await setup();
    const strategyId = await approveStrategy(offeringId);
    await call('POST', '/api/admin/material/generate', {
      jar: admin.jar,
      body: { offeringId, chapters: [3] },
    });
    const notes = await json<any[]>(
      await call('GET', `/api/admin/material/assets?offeringId=${offeringId}`, { jar: admin.jar }),
    );
    expect(notes.length).toBeGreaterThan(1);
    const publish = () =>
      call('POST', '/api/admin/material/publish', { jar: admin.jar, body: { offeringId } });
    expect((await publish()).status).toBe(400); // nothing approved yet
    const [a, b] = notes;
    for (const n of [a, b])
      await call('POST', `/api/admin/material/assets/${n.id}/review`, {
        jar: admin.jar,
        body: { decision: 'approve', score: 4 },
      });

    const first = await json<any>(await publish());
    expect(first).toMatchObject({
      offeringId,
      strategy: { id: strategyId, version: 1 },
      counts: { note: 2, cards: 0, questions: 0, graph: 0 },
      chapters: [3],
      books: [{ bookId, title: 'NCERT Accountancy Part I', version: 'v1' }],
    });
    // Add-only: the next publish is a new file, the first stays
    const second = await json<any>(await publish());
    expect(second.version).toBe(first.version + 1);
    expect(await env.CONTENT.head(`material/${offeringId}/v${first.version}.json`)).not.toBeNull();
    const pkg = await (await env.CONTENT.get(
      `material/${offeringId}/v${second.version}.json`,
    ))!.json<any>();
    expect(pkg.assets.map((x: any) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(JSON.stringify(pkg)).not.toContain('cost');

    // "Another environment": same reference data and books, no strategy or material.
    await env.DB.batch(
      ['asset_reviews', 'learning_assets', 'generation_runs', 'board_items', 'exam_strategies'].map(
        (t) => env.DB.prepare(`DELETE FROM ${t}`),
      ),
    );
    let shared = await json<any>(
      await call('GET', `/api/admin/material/shared?offeringId=${offeringId}`, { jar: admin.jar }),
    );
    expect(shared).toMatchObject({
      canPublish: true,
      package: { version: second.version, here: 0, total: 2, upToDate: false },
    });
    const imp = () =>
      call('POST', '/api/admin/material/import', { jar: admin.jar, body: { offeringId } });

    // A cited textbook that is not imported here → refused
    await env.DB.prepare("UPDATE books SET status = 'review' WHERE id = ?").bind(bookId).run();
    const refused = await imp();
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain('NCERT Accountancy Part I');
    await env.DB.prepare("UPDATE books SET status = 'published' WHERE id = ?").bind(bookId).run();

    expect(await json(await imp())).toMatchObject({
      strategy: 'imported',
      imported: 2,
      skipped: 0,
      warnings: [],
    });
    expect(await json(await imp())).toMatchObject({
      strategy: 'already here',
      imported: 0,
      skipped: 2,
    });
    shared = await json<any>(
      await call('GET', `/api/admin/material/shared?offeringId=${offeringId}`, { jar: admin.jar }),
    );
    expect(shared.package).toMatchObject({ here: 2, upToDate: true });

    // Learners see it as approved material
    const student = await createSignedInUser('student');
    const sid = (await env.DB.prepare('SELECT id FROM user WHERE email = ?')
      .bind(student.email)
      .first<{ id: string }>())!.id;
    await env.DB.prepare(
      "INSERT INTO enrolments (id, user_id, role_in, offering_id, status) VALUES (?, ?, 'student', ?, 'active')",
    )
      .bind(crypto.randomUUID(), sid, offeringId)
      .run();
    const index = await json<any>(await call('GET', '/api/material', { jar: student.jar }));
    expect(index.ready).toBe(true);
    const ch3 = await json<any>(
      await call('GET', '/api/material/chapters/3', { jar: student.jar }),
    );
    expect(ch3.notes).toHaveLength(2);
    const strat = await env.DB.prepare('SELECT status, version FROM exam_strategies').all();
    expect(strat.results).toEqual([{ status: 'approved', version: 1 }]);
  });
});
