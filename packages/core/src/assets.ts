import { z } from 'zod';
import { COGNITIVE, DIFFICULTY, type ExamStrategy } from './strategy';

/**
 * Learning material generated from the approved exam strategy (architecture §7 Phase 3, decision
 * 9.5-4). Every asset lives in a stable SLOT (e.g. a note for one topic at one marks level) with
 * versions, so a regeneration (e.g. with a stronger model before production) supersedes the content
 * while learner data keeps pointing at the slot.
 */

/**
 * note = per topic × marks level; cards = per chapter (memory map + quick cards);
 * questions = our own question bank, per chapter × marks level the blueprint asks it at;
 * graph = the subject's concept graph (topic prerequisites), one per subject.
 */
export const ASSET_KINDS = ['note', 'cards', 'questions', 'graph'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const ASSET_STATUSES = ['draft', 'approved', 'rejected', 'superseded'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/**
 * Notes per marks weightage (spec 2.1.1). A note has two parts (prompt note@2):
 * - the EXAM ANSWER: what a student writes for full marks, sized to the time the paper allows
 *   (see examBudget); `workedExample` = it is a fully worked problem; `shape` = what it contains;
 * - the STUDY part (summary + sections): understanding, read not memorised; `minWords`–`maxWords`
 *   is a loose guide (only the upper end is checked).
 */
export const MARKS_TARGETS: Record<
  number,
  { minWords: number; maxWords: number; workedExample: boolean; shape: string }
> = {
  1: {
    minWords: 30,
    maxWords: 120,
    workedExample: false,
    shape: 'the exact term, fact or one-line answer the examiner looks for',
  },
  2: {
    minWords: 60,
    maxWords: 200,
    workedExample: false,
    shape:
      'two clear points (features, differences, steps, or a small calculation), each worth one mark',
  },
  6: {
    minWords: 150,
    maxWords: 400,
    workedExample: true,
    shape:
      'one fully worked 6-mark problem in the exam format (entries, accounts or statements, working notes) with the marks for each step',
  },
  12: {
    minWords: 200,
    maxWords: 600,
    workedExample: true,
    shape:
      'one fully worked 12-mark problem in the exam format (all the accounts and statements asked, working notes) with the marks for each part',
  },
};
/** Marks levels without their own row use the closest one below. */
export function marksTarget(marks: number) {
  const level = [12, 6, 2, 1].find((m) => marks >= m) ?? 1;
  return { level, ...MARKS_TARGETS[level]! };
}

/**
 * Rough handwriting pace in an exam, counting every word, number and table cell (thinking time
 * included). Used to size the exam answer to the minutes the paper allows.
 */
export const EXAM_WORDS_PER_MINUTE = 15;
/** Minutes per mark when the strategy has no timing for this marks level (180 min / 80 marks). */
export const DEFAULT_MINUTES_PER_MARK = 2.25;

/** Time and length budget for the exam answer: from the paper's minutes per question at this marks level. */
export function examBudget(marks: number, minutesPerQuestion?: number | null) {
  const minutes =
    Math.round((minutesPerQuestion ?? marks * DEFAULT_MINUTES_PER_MARK) * 10) / 10 || 1;
  return { minutes, maxWords: Math.max(10, Math.round(minutes * EXAM_WORDS_PER_MINUTE)) };
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .transform((s) => s.slice(0, max));

/** What the writer (and the fixer) return. Markdown; [S#] cites the numbered textbook excerpts. */
export const noteDraftSchema = z.object({
  title: text(160),
  /** One or two sentences: what a student must know (answer-first). */
  summary: text(600),
  sections: z
    .array(z.object({ heading: text(120), body: text(6000) }))
    .min(1)
    .max(12),
  /** "Write this in the exam": a board-style question and the full-marks answer, sized to the time. */
  examAnswer: z.object({
    question: text(3000),
    /** Markdown; for 6/12 marks the worked solution (tables for accounts/statements, working notes). */
    answer: text(12000),
    /** Marks allotment the way the scheme of evaluation writes it, e.g. "1+2+2+1=6". */
    marksSplit: text(120).nullable().default(null),
    /** Minutes the paper allows for it. */
    minutes: z.coerce.number().positive().max(60).nullable().default(null),
  }),
  keyTerms: z.array(text(200)).max(20).default([]),
  examTips: z.array(text(300)).max(10).default([]),
  /** Spec 5.5.12: exam utility + a real-world hook. */
  whyThisMatters: z.object({ exam: text(400), realWorld: text(400) }),
});
export type NoteDraft = z.infer<typeof noteDraftSchema>;
/** Notes written with prompt note@1 have a worked example (6/12 marks) and no exam answer. */
export interface LegacyWorkedExample {
  question: string;
  solution: string;
  marksSplit: string | null;
}
export type StoredNote = Omit<NoteDraft, 'examAnswer'> & {
  examAnswer?: NoteDraft['examAnswer'];
  workedExample?: LegacyWorkedExample | null;
};

export const RUBRIC = ['accuracy', 'grounded', 'marksFit', 'presentation', 'clarity'] as const;
export const RUBRIC_LABELS: Record<(typeof RUBRIC)[number], string> = {
  accuracy: 'Correct (facts, figures, totals)',
  grounded: 'Backed by the textbook excerpts',
  marksFit: 'Right depth for the marks',
  presentation: 'Board presentation (formats, working notes)',
  clarity: 'Clear for a student',
};

/** What the critic returns. */
export const critiqueSchema = z.object({
  scores: z.object(
    Object.fromEntries(RUBRIC.map((k) => [k, z.coerce.number().min(1).max(5)])) as Record<
      (typeof RUBRIC)[number],
      z.ZodNumber
    >,
  ),
  issues: z
    .array(
      z.object({
        severity: z.enum(['major', 'minor']),
        where: text(160),
        problem: text(500),
        fix: text(500),
      }),
    )
    .max(20)
    .default([]),
  verdict: z.enum(['pass', 'fix']),
});
export type Critique = z.infer<typeof critiqueSchema>;

export interface AssetCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AssetSource {
  n: number;
  bookId: string;
  bookTitle: string;
  page: number;
  section: string | null;
}

/**
 * Models sometimes cite several excerpts in one bracket ("[S1, S6]"). Everything that reads
 * citations expects one marker each, so this rewrites it to "[S1][S6]".
 */
export function splitCitations(text: string): string {
  return text.replace(/\[(S\d+(?:\s*[,;&]\s*S?\d+)+)\]/g, (_, list: string) =>
    (list.match(/\d+/g) ?? []).map((n) => `[S${n}]`).join(''),
  );
}

/** Text without its citation markers (for a recall card, where a page badge would be noise). */
export const stripCitations = (text: string) =>
  text
    .replace(/\s*\[S\d+(?:\s*[,;&]\s*S?\d+)*\]/g, '')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();

/** "note:3:gaining-ratio:6" (kind, chapter, topic slug, marks): stable across regenerations. */
export function slotKey(kind: AssetKind, chapter: number, topic: string, marks: number) {
  const slug = topic
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${kind}:${chapter}:${slug}:${marks}`;
}

// ------------------------------------------------------------- cards + memory maps (spec 2.4)

export const CARD_TYPES = [
  'definition',
  'formula',
  'format',
  'rule',
  'difference',
  'fact',
] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** Concise by design (attention rule): short fronts, short backs, a map that fits one screen. */
export const CARD_LIMITS = {
  minCards: 8,
  maxCards: 40,
  frontWords: 20,
  backWords: 45,
  maxBranches: 12,
  maxPoints: 6,
  pointWords: 14,
} as const;

/** What the cards writer (and fixer) return for one chapter. [S#] cites the numbered excerpts. */
export const cardsDraftSchema = z.object({
  title: text(160),
  /** Memory map: the chapter at the centre, one branch per main topic, a few short points each. */
  map: z.object({
    center: text(160),
    branches: z
      .array(
        z.object({
          label: text(120),
          topic: text(200).nullable().default(null),
          points: z.array(text(240)).max(10).default([]),
        }),
      )
      .min(2)
      .max(16),
  }),
  cards: z
    .array(
      z.object({
        topic: text(200),
        type: z.enum(CARD_TYPES).catch('fact'),
        front: text(300),
        back: text(800),
        /** The excerpt it comes from, e.g. "S3". */
        cite: text(12).nullable().default(null),
      }),
    )
    .min(3)
    .max(60),
});
export type CardsDraft = z.infer<typeof cardsDraftSchema>;

/**
 * Subject-wise memory map (spec 2.4), built by code from the approved strategy (no model call):
 * each chapter's marks weight, which parts it is asked in, and its most-asked topics.
 */
export function subjectMap(s: ExamStrategy) {
  const total = s.chapters.reduce((n, c) => n + c.marks, 0) || 1;
  return {
    subject: `${s.board} ${s.className} ${s.subject}`,
    papers: s.exams?.papers ?? 0,
    chapters: s.chapters.map((c) => ({
      no: c.no,
      title: c.title,
      marks: c.marks,
      share: Math.round((c.marks / total) * 100),
      parts: (['A', 'B', 'C', 'D'] as const).filter(
        (p) => (c[`part${p}` as 'partA' | 'partB' | 'partC' | 'partD'] ?? 0) > 0,
      ),
      topTopics: [...(c.topics ?? [])]
        .sort((a, b) => b.examPapers - a.examPapers || b.bankItems - a.bankItems)
        .slice(0, 5)
        .map((t) => ({ name: t.name, examPapers: t.examPapers, marks: t.marks })),
    })),
  };
}
export type SubjectMap = ReturnType<typeof subjectMap>;

// ------------------------------------------------------------- our own question bank

/** Question types (the strategy's typology names for the board paper). */
export const QUESTION_TYPOLOGIES = [
  'mcq',
  'fill_blank',
  'match',
  'very_short',
  'expand',
  'true_false',
  'short_answer',
  'problem',
] as const;
export type QuestionTypology = (typeof QUESTION_TYPOLOGIES)[number];

/** Questions per set (one set = one chapter at one marks level). */
export const QUESTIONS_PER_SET: Record<number, number> = { 1: 10, 2: 5, 6: 3, 12: 2 };
export const questionsPerSet = (marks: number) => QUESTIONS_PER_SET[marksTarget(marks).level] ?? 3;

/** Blueprint part → marks per question (KSEAB 2nd PUC: A 1, B 2, C 6, D 12), when the strategy has none. */
export const PART_MARKS = { A: 1, B: 2, C: 6, D: 12 } as const;

export const questionSchema = z.object({
  topic: text(200),
  typology: z.enum(QUESTION_TYPOLOGIES).catch('short_answer'),
  difficulty: z.enum(DIFFICULTY).catch('average'),
  cognitive: z.enum(COGNITIVE).catch('understand'),
  /** Markdown (tables for the data of a problem). */
  question: text(4000),
  /** MCQ options (4), otherwise null. */
  options: z.array(text(300)).max(6).nullable().default(null),
  /** Model answer as a centum script presents it (Markdown; tables for accounts). */
  answer: text(12000),
  /** What the examiner awards marks for, the way a scheme of evaluation writes it. */
  markingPoints: z
    .array(z.object({ point: text(400), marks: z.coerce.number().min(0).max(12) }))
    .max(20)
    .default([]),
  marksSplit: text(120).nullable().default(null),
  /** The textbook excerpt it rests on, e.g. "S3". */
  cite: text(12).nullable().default(null),
});
export type GeneratedQuestion = z.infer<typeof questionSchema>;

export const questionSetSchema = z.object({ questions: z.array(questionSchema).min(1).max(15) });
export type QuestionSet = z.infer<typeof questionSetSchema>;

// ------------------------------------------------------------- concept graph (prerequisites)

/** A topic of the approved strategy, with a stable id ("c3.2" = chapter 3, topic 2). */
export interface ConceptNode {
  id: string;
  chapter: number;
  topic: string;
}

/** The strategy's topics as graph nodes. */
export function graphNodes(s: ExamStrategy): ConceptNode[] {
  return s.chapters.flatMap((c) =>
    (c.topics ?? []).map((t, i) => ({ id: `c${c.no}.${i + 1}`, chapter: c.no, topic: t.name })),
  );
}

/** What the graph writer returns: "from" must be understood before "to". */
export const conceptGraphSchema = z.object({
  edges: z
    .array(z.object({ from: text(20), to: text(20), why: text(300) }))
    .max(400)
    .default([]),
});
export type ConceptGraphDraft = z.infer<typeof conceptGraphSchema>;
/** Stored: the nodes (from the strategy) and the valid edges. */
export type StoredGraph = { nodes: ConceptNode[] } & ConceptGraphDraft;

/** A cycle of node ids (a → b → … → a) if the edges have one, else null. */
export function findCycle(nodes: string[], edges: { from: string; to: string }[]): string[] | null {
  const next = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const e of edges) next.get(e.from)?.push(e.to);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of next.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.has(m)) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of nodes)
    if (!state.has(n)) {
      const c = visit(n);
      if (c) return c;
    }
  return null;
}
