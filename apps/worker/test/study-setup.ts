import { env } from 'cloudflare:workers';
import { PDFDocument } from 'pdf-lib';
import { call, createSignedInUser, json, seedPilotTaxonomy, type Jar } from './helpers';
import type { MockState } from './openrouter-mock';

/** Shared fixture for study-session tests: a published book, a funded class, approved material. */

export const STUDY_TABLES = [
  'safety_events',
  'session_events',
  'study_sessions',
  'mastery',
  'card_reviews',
  'learner_artefacts',
  'learner_interests',
  'parent_contacts',
  'asset_reviews',
  'learning_assets',
  'generation_runs',
  'board_items',
  'exam_strategies',
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

const PAGES: Record<string, string> = {
  'page-1.pdf':
    '## 1.1 Partnership deed\n\nA partnership deed is the written agreement among partners. It states the profit sharing ratio, interest on capital and interest on drawings.',
  'page-2.pdf':
    '## 2.1 Goodwill\n\nGoodwill is the value of the reputation of a firm in respect of the profits expected in future over and above the normal profits.',
  'page-3.pdf':
    '## 3.1 Revaluation Account\n\nThe revaluation account records the increase or decrease in the values of assets and liabilities on reconstitution.',
};

export const STRATEGY = {
  schema: 'exam_strategy@1',
  board: 'KSEAB',
  className: '2nd PUC',
  subject: 'Accountancy',
  chapters: [
    {
      no: 1,
      title: 'Partnership basics',
      marks: 14,
      partA: 2,
      partB: 1,
      partC: 1,
      partD: 0,
      topics: [
        { name: 'Goodwill', marks: [1, 6], examPapers: 4, bankItems: 3 },
        { name: 'Partnership deed', marks: [1], examPapers: 2, bankItems: 2 },
      ],
      problemSpecs: [],
    },
    {
      no: 2,
      title: 'Admission of a partner',
      marks: 8,
      partA: 1,
      partB: 1,
      partC: 0,
      partD: 0,
      topics: [{ name: 'Sacrificing ratio', marks: [2], examPapers: 1, bankItems: 1 }],
      problemSpecs: [],
    },
  ],
  parts: [
    { part: 'A', marksEach: 1, minutesPerQuestion: 2.3 },
    { part: 'B', marksEach: 2, minutesPerQuestion: 4.5 },
    { part: 'C', marksEach: 6, minutesPerQuestion: 13.5 },
  ],
  exams: { papers: 8, years: [2024], labels: [] },
  answerConventions: [],
};

const SOURCES = [
  { n: 1, bookId: 'b', bookTitle: 'NCERT Accountancy Part I', page: 2, section: null },
];

const note = (topic: string, marks: number, worked = false) => ({
  title: topic,
  summary: `${topic} in one line: the textbook defines it clearly [S1].`,
  sections: [
    { heading: 'Meaning', body: `What ${topic} means [S1].` },
    { heading: 'In the exam', body: `How ${topic} is asked [S1].` },
  ],
  examAnswer: worked
    ? {
        question: `Calculate ${topic} at two years' purchase of ₹30,000.`,
        answer: `${topic} = 30,000 × 2 = 60,000 [S1]`,
        marksSplit: '1+2+2+1=6',
        minutes: 13.5,
      }
    : {
        question: `What is ${topic}?`,
        answer: `${topic} is the value of the reputation of a firm [S1].`,
        marksSplit: null,
        minutes: 2.3,
      },
  keyTerms: ['reputation', 'future profits'],
  examTips: [],
  whyThisMatters: { exam: 'Asked in most papers.', realWorld: 'Buyers pay for a known name.' },
});

export const CARDS = {
  title: 'Partnership basics',
  map: {
    center: 'Partnership basics',
    branches: [
      { label: 'Goodwill', topic: 'Goodwill', points: ['Reputation'] },
      { label: 'Deed', topic: 'Partnership deed', points: ['Agreement'] },
    ],
  },
  cards: [
    {
      topic: 'Goodwill',
      type: 'definition',
      front: 'What is goodwill?',
      back: 'Value of reputation',
      cite: 'S1',
    },
    {
      topic: 'Goodwill',
      type: 'fact',
      front: 'Is goodwill tangible?',
      back: 'No, intangible',
      cite: 'S1',
    },
    {
      topic: 'Partnership deed',
      type: 'definition',
      front: 'What is a deed?',
      back: 'Written agreement',
      cite: 'S1',
    },
  ],
};

const question = (o: Record<string, unknown>) => ({
  difficulty: 'easy',
  cognitive: 'remember',
  options: null,
  markingPoints: [],
  marksSplit: null,
  cite: 'S1',
  ...o,
});
const QUESTIONS_1 = {
  questions: [
    question({
      topic: 'Goodwill',
      typology: 'very_short',
      question: 'Define goodwill.',
      answer: 'Goodwill is the value of the reputation of a firm [S1].',
      markingPoints: [{ point: 'Value of reputation', marks: 1 }],
    }),
    question({
      topic: 'Partnership deed',
      typology: 'mcq',
      question: 'A partnership deed is:',
      options: [
        '(a) An oral promise',
        '(b) A written agreement',
        '(c) A balance sheet',
        '(d) A ledger',
      ],
      answer: '(b) A written agreement [S1]',
      markingPoints: [{ point: 'Correct option', marks: 1 }],
    }),
  ],
};

async function seedMaterial(offeringId: string, adminId: string) {
  const asset = (
    id: string,
    kind: string,
    chapter: number,
    topic: string,
    marks: number,
    content: unknown,
  ) =>
    env.DB.prepare(
      `INSERT INTO learning_assets (id, offering_id, slot_key, version, kind, chapter, topic, marks, status, content, checks, sources, generator, strategy_id, reviewed_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'approved', ?, '[]', ?, 'test', 'strat1', 1)`,
    ).bind(
      id,
      offeringId,
      `${kind}:${chapter}:${topic.toLowerCase().replace(/\W+/g, '-')}:${marks}`,
      kind,
      chapter,
      topic,
      marks,
      JSON.stringify(content),
      JSON.stringify(SOURCES),
    );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO exam_strategies (id, offering_id, version, status, strategy, source_book_ids, prompt_version, created_by)
       VALUES ('strat1', ?, 1, 'approved', ?, '[]', 'test', ?)`,
    ).bind(offeringId, JSON.stringify({ ...STRATEGY, offeringId }), adminId),
    asset('n1', 'note', 1, 'Goodwill', 1, note('Goodwill', 1)),
    asset('n2', 'note', 1, 'Goodwill', 6, note('Goodwill', 6, true)),
    asset('n3', 'note', 1, 'Partnership deed', 1, note('Partnership deed', 1)),
    asset('c1', 'cards', 1, 'Partnership basics', 0, CARDS),
    asset('q1', 'questions', 1, 'Partnership basics', 1, QUESTIONS_1),
    asset('g1', 'graph', 0, 'Concept graph', 0, {
      nodes: [
        { id: 'c1.1', chapter: 1, topic: 'Goodwill' },
        { id: 'c1.2', chapter: 1, topic: 'Partnership deed' },
      ],
      edges: [{ from: 'c1.2', to: 'c1.1', why: 'The deed sets the ratio' }],
    }),
  ]);
}

export interface Study {
  offeringId: string;
  admin: { email: string; jar: Jar };
  poc: { email: string; jar: Jar };
  teacher: { email: string; jar: Jar };
  student: { email: string; jar: Jar; id: string };
  /** The student's class wallet (pays first). */
  studentW: { id: string };
  cls: { id: string; joinCode: string };
}

/** `credits`: what the student's class wallet gets ('0' = none). */
export async function setupStudy(or: MockState, credits = '10'): Promise<Study> {
  const offeringId = await seedPilotTaxonomy();
  const admin = await createSignedInUser('admin');
  const poc = await createSignedInUser('institution_poc');
  const teacher = await createSignedInUser('teacher');
  const student = await createSignedInUser('student', 'Asha Rao');
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
      body: { name: 'Study College', type: 'college' },
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
  if (credits !== '0')
    await call('POST', '/api/credits/allotments', {
      jar: teacher.jar,
      body: { fromWalletId: classW.id, toWalletId: studentW.id, credits },
    });
  const ids = await env.DB.prepare('SELECT id, email FROM user WHERE email IN (?, ?)')
    .bind(admin.email, student.email)
    .all<{ id: string; email: string }>();
  const idOf = (email: string) => ids.results.find((r) => r.email === email)!.id;
  await seedMaterial(offeringId, idOf(admin.email));
  return {
    offeringId,
    admin,
    poc,
    teacher,
    student: { ...student, id: idOf(student.email) },
    studentW,
    cls,
  };
}

export const balanceOf = async (walletId: string) =>
  (await env.DB.prepare('SELECT balance_micro b FROM wallets WHERE id = ?')
    .bind(walletId)
    .first<{ b: number }>())!.b;

export async function sse(res: Response) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)));
}
