import { z } from 'zod';

/**
 * Exam strategy (architecture §3.5, decision 9.5-2). The model's extraction outputs are validated
 * with these schemas; the final ExamStrategy is assembled in code and checked against the
 * blueprint's own arithmetic (chapter marks, part counts, marks to answer).
 */

export const PARTS = ['A', 'B', 'C', 'D'] as const;
export type Part = (typeof PARTS)[number];

export const TYPOLOGIES = [
  'mcq',
  'fill_blank',
  'match',
  'true_false',
  'expand',
  'very_short',
  'short_answer',
  'problem',
] as const;
export const TYPOLOGY_LABELS: Record<(typeof TYPOLOGIES)[number], string> = {
  mcq: 'Multiple choice',
  fill_blank: 'Fill in the blank',
  match: 'Match the following',
  true_false: 'True / false',
  expand: 'Expand the abbreviation',
  very_short: 'Very short answer',
  short_answer: 'Short answer (theory / small calculation)',
  problem: 'Problem',
};
export const COGNITIVE = ['remember', 'understand', 'apply', 'analyse'] as const;
export const DIFFICULTY = ['easy', 'average', 'hots'] as const;
/** Where a question comes from; frequency counts only real board exams. */
export const ITEM_SOURCES = ['board_exam', 'model_paper', 'practice_paper', 'bank'] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

const int = z.coerce.number().int();
const text = (max: number) =>
  z
    .string()
    .trim()
    .transform((s) => s.slice(0, max));

// ---------------------------------------------------------------- step 1: paper pattern

export const structureExtractSchema = z.object({
  academicYear: z.string().trim().max(20).nullable().default(null),
  durationMin: int.positive(),
  readingTimeMin: int.nonnegative().default(0),
  maxMarks: int.positive(),
  questionsOnPaper: int.positive().nullable().default(null),
  parts: z
    .array(
      z.object({
        part: z.enum(PARTS),
        marksEach: int.positive(),
        asked: int.positive(),
        toAnswer: int.positive(),
        typology: z.array(text(80)).default([]),
        chapters: z.array(int.positive()).default([]),
        instructions: z.array(text(300)).default([]),
      }),
    )
    .length(4),
  chapters: z
    .array(
      z.object({
        no: int.positive(),
        title: text(160),
        hours: int.nonnegative(),
        marks: int.nonnegative(),
        /** Number of questions of each part from this chapter. */
        partA: int.nonnegative(),
        partB: int.nonnegative(),
        partC: int.nonnegative(),
        partD: int.nonnegative(),
        note: text(300).nullable().default(null),
      }),
    )
    .min(1)
    .max(40),
  /** Officially allowed problem types per chapter for 6 and 12 mark questions. */
  problemSpecs: z
    .array(
      z.object({
        chapter: int.positive().nullable(),
        part: z.enum(['C', 'D']),
        allowed: z.array(text(400)).min(1),
      }),
    )
    .default([]),
  notes: z.array(text(300)).default([]),
});
export type StructureExtract = z.infer<typeof structureExtractSchema>;

export interface StrategyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** The blueprint's own arithmetic: proves the compiled pattern matches the official blueprint. */
export function blueprintChecks(s: StructureExtract): StrategyCheck[] {
  const part = (p: Part) => s.parts.find((x) => x.part === p);
  const perChapter = (c: StructureExtract['chapters'][number], p: Part) =>
    ({ A: c.partA, B: c.partB, C: c.partC, D: c.partD })[p];
  const checks: StrategyCheck[] = [];
  const onPaper = s.parts.reduce((n, p) => n + p.asked * p.marksEach, 0);
  const chapterMarks = s.chapters.reduce((n, c) => n + c.marks, 0);
  checks.push({
    name: 'Chapter marks add up to the marks on the paper',
    ok: chapterMarks === onPaper,
    detail: `chapters ${chapterMarks}, parts ${onPaper}`,
  });
  const toAnswer = s.parts.reduce((n, p) => n + p.toAnswer * p.marksEach, 0);
  checks.push({
    name: 'Marks of the questions to answer equal the maximum marks',
    ok: toAnswer === s.maxMarks,
    detail: `${toAnswer} vs ${s.maxMarks}`,
  });
  for (const p of PARTS) {
    const pt = part(p);
    const n = s.chapters.reduce((sum, c) => sum + perChapter(c, p), 0);
    checks.push({
      name: `Part ${p}: chapter questions add up to the questions asked`,
      ok: !!pt && n === pt.asked,
      detail: `${n} from chapters vs ${pt?.asked ?? '?'} asked`,
    });
  }
  const wrong = s.chapters.filter(
    (c) =>
      c.marks !== PARTS.reduce((sum, p) => sum + perChapter(c, p) * (part(p)?.marksEach ?? 0), 0),
  );
  checks.push({
    name: "Each chapter's marks equal its questions × marks",
    ok: wrong.length === 0,
    detail: wrong.length ? `differs for chapter ${wrong.map((c) => c.no).join(', ')}` : 'all match',
  });
  return checks;
}

// ---------------------------------------------------------------- steps 2-3: questions

export const questionExtractSchema = z.object({
  questions: z
    .array(
      z.object({
        qno: text(20),
        part: z.enum(PARTS).nullable().default(null),
        marks: int.min(1).max(20).nullable().default(null),
        chapter: int.min(1).max(40).nullable().default(null),
        topic: text(140),
        typology: z.enum(TYPOLOGIES),
        cognitive: z.enum(COGNITIVE).nullable().default(null),
        difficulty: z.enum(DIFFICULTY).nullable().default(null),
        text: text(700),
        page: int.positive().nullable().default(null),
        /** Question bank: which section the question is in (chapter-wise bank, or an embedded paper). */
        source: z.enum(ITEM_SOURCES).nullable().default(null),
        /** Embedded paper label, e.g. "A1-2024", "Model paper 1 2024-25". */
        paperLabel: text(80).nullable().default(null),
        examYear: int.min(2000).max(2100).nullable().default(null),
      }),
    )
    .max(400),
  /** Question bank windows: where the last page ended (carried into the next window). */
  endsIn: text(160).nullable().default(null),
});
export type QuestionExtract = z.infer<typeof questionExtractSchema>;

// ---------------------------------------------------------------- step 4: schemes

export const schemeExtractSchema = z.object({
  answers: z
    .array(
      z.object({
        qno: text(20),
        answer: text(1500),
        markSplit: text(80).nullable().default(null),
        markingPoints: z
          .array(z.object({ point: text(300), marks: z.coerce.number().min(0).max(20) }))
          .max(25)
          .default([]),
        note: text(300).nullable().default(null),
      }),
    )
    .max(80),
});
export type SchemeExtract = z.infer<typeof schemeExtractSchema>;

// ---------------------------------------------------------------- step 5: presentation

export const ANSWER_FORMATS = [
  'journal_entry',
  'ledger_account',
  'balance_sheet',
  'profit_and_loss',
  'cash_flow',
  'ratio',
  'comparative_common_size',
  'working_notes',
  'theory',
  'general',
] as const;
export const conventionsExtractSchema = z.object({
  conventions: z
    .array(
      z.object({
        format: z.enum(ANSWER_FORMATS),
        rule: text(400),
        example: text(400).nullable().default(null),
        source: text(160).nullable().default(null),
      }),
    )
    .max(40),
});
export type ConventionsExtract = z.infer<typeof conventionsExtractSchema>;

// ---------------------------------------------------------------- step 6: topics

export const topicsExtractSchema = z.object({
  topics: z.array(z.object({ name: text(140), items: z.array(text(20)).min(1) })).max(60),
});

// ---------------------------------------------------------------- the strategy

export interface TopicStat {
  name: string;
  /** Distinct board exam papers it was asked in (of `exams.papers`). */
  examPapers: number;
  examYears: number[];
  modelPapers: number;
  bankItems: number;
  parts: Part[];
  marks: number[];
}

export interface ExamStrategy {
  schema: 'exam_strategy@1';
  board: string;
  className: string;
  subject: string;
  offeringId: string;
  academicYear: string | null;
  durationMin: number;
  readingTimeMin: number;
  maxMarks: number;
  questionsOnPaper: number | null;
  minutesPerMark: number;
  parts: (StructureExtract['parts'][number] & {
    marksOnPaper: number;
    marksToAnswer: number;
    minutesPerQuestion: number;
  })[];
  chapters: (StructureExtract['chapters'][number] & {
    topics: TopicStat[];
    examAppearances: number;
    problemSpecs: { part: 'C' | 'D'; allowed: string[] }[];
  })[];
  exams: { papers: number; years: number[]; labels: string[] };
  modelPapers: number;
  typologyByPart: Record<Part, Record<string, number>>;
  cognitive: Record<string, number>;
  difficulty: Record<string, number>;
  markSplits: { part: Part; split: string; count: number }[];
  answerConventions: ConventionsExtract['conventions'];
  priorities: string[];
  notes: string[];
  checks: StrategyCheck[];
  sources: { bookId: string; title: string; category: string; academicYear: string | null }[];
  stats: { questions: number; withMarking: number; bankItems: number; examItems: number };
}
