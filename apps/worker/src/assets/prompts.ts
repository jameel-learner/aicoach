/**
 * Prompts for generated learning material (architecture §7 Phase 3, decision 9.5-4).
 * Model-neutral on purpose: the same prompts run on Gemini in development and on Claude Opus /
 * Sonnet for the pre-production regeneration. Change a prompt → bump ASSET_PROMPT_VERSION.
 *
 * note@2: a note has an EXAM ANSWER ("write this in the exam", sized to the minutes the paper
 * allows) and a STUDY part ("understand it", read not memorised).
 */

export const ASSET_PROMPT_VERSION = 'note@2';

const JSON_ONLY = 'Reply with ONE JSON object only (no Markdown fences, no commentary).';

export interface NoteContext {
  board: string;
  className: string;
  subject: string;
  chapter: number;
  chapterTitle: string;
  topic: string;
  marks: number;
  target: { minWords: number; maxWords: number; workedExample: boolean; shape: string };
  /** Time the paper allows for one question at this level, and what can be written in it. */
  exam: { minutes: number; maxWords: number };
  /** Officially allowed problem types for this chapter at this marks level. */
  allowed: string[];
  /** Past board / model questions on this topic, with the scheme's marks split. */
  examples: {
    label: string;
    marks: number | null;
    text: string;
    markSplit: string | null;
    answer: string | null;
  }[];
  conventions: { format: string; rule: string }[];
  excerpts: { n: number; page: number; section: string | null; text: string }[];
}

const contextText = (c: NoteContext) =>
  [
    `Subject: ${c.board} ${c.className} ${c.subject}`,
    `Chapter ${c.chapter}: ${c.chapterTitle}`,
    `Topic: ${c.topic}`,
    `Marks level: ${c.marks} mark${c.marks === 1 ? '' : 's'}. The paper allows about ${c.exam.minutes} minutes for such a question, so the exam answer must be writable in that time: at most about ${c.exam.maxWords} words, counting every number and table cell. A full-marks exam answer at this level is ${c.target.shape}. The study part: about ${c.target.minWords}–${c.target.maxWords} words.`,
    c.allowed.length
      ? `The board's allowed problem types for this chapter at this level:\n${c.allowed.map((a) => `- ${a}`).join('\n')}`
      : '',
    c.examples.length
      ? `How this topic was asked in board / model papers (with the scheme's marks allotment):\n${c.examples
          .map(
            (e) =>
              `- [${e.label}, ${e.marks ?? '?'} marks] ${e.text}${e.markSplit ? ` | marks: ${e.markSplit}` : ''}${e.answer ? ` | scheme: ${e.answer.slice(0, 400)}` : ''}`,
          )
          .join('\n')}`
      : '',
    `How full-marks answers are presented (from centum answer scripts):\n${c.conventions
      .map((r) => `- (${r.format}) ${r.rule}`)
      .join('\n')}`,
    `Textbook excerpts (cite as [S#]):\n\n${c.excerpts
      .map((e) => `[S${e.n}] (page ${e.page}${e.section ? `, ${e.section}` : ''})\n${e.text}`)
      .join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');

const NOTE_SHAPE =
  '{"title":"...","summary":"...","sections":[{"heading":"...","body":"Markdown ... [S1]"}],"examAnswer":{"question":"...","answer":"Markdown (tables for accounts and statements)","marksSplit":"1+2+2+1=6","minutes":13.5},"keyTerms":["..."],"examTips":["..."],"whyThisMatters":{"exam":"...","realWorld":"..."}}';

export const WRITER_PROMPT = {
  system: [
    'You write exam-ready study notes for students preparing for their board exam, for one topic at one marks level.',
    JSON_ONLY,
    `Shape: ${NOTE_SHAPE}`,
    'Rules:',
    '- Facts, definitions, formats and rules come ONLY from the textbook excerpts; cite them after the sentence like [S2]. Never invent figures, sections or page numbers.',
    '- The note has two parts. examAnswer = "Write this in the exam": a board-style question at this marks level and the answer a student writes for full marks, exactly as a centum script presents it, short enough to write in the minutes given (see the brief). It is the only part a student practises writing. summary and sections = "Understand it": the why, the method and the format explained for understanding, to be read, not memorised; do not repeat the exam answer there.',
    '- Answer first: the summary says in one or two sentences what the student must know for this question.',
    '- For 1 mark: examAnswer.answer is the exact term, fact or one line (a board-style MCQ, fill in the blank, match or very short question); marksSplit may be null. For 2 marks: two points, one mark each, marksSplit "1+1=2".',
    '- For 6 and 12 marks: examAnswer is ONE problem in the style of the board questions shown (your own numbers, not a copy), solved completely the way the centum scripts present it: Markdown tables for journal entries, ledger accounts and statements (Dr and Cr sides, totals that tally), brief working notes, and the marks allotment for each step in marksSplit (its total must equal the marks). Keep the problem small enough that its full solution can be written in the minutes given. No explanations inside the answer: only what is written in the exam.',
    '- Check every figure in the exam answer: totals on both sides of an account must agree, a balance sheet must balance.',
    '- examAnswer.minutes: the minutes the paper allows (from the brief).',
    '- Formulas in plain text, e.g. "Current Ratio = Current Assets ÷ Current Liabilities". Amounts in ₹ with Indian grouping (1,27,300).',
    '- examTips: what examiners reward or penalise for this question (from the marks allotments and presentation rules), and how to stay within the time. whyThisMatters: why it matters in the exam (marks, how often asked) and a short real-world hook.',
  ].join('\n'),
  user: (c: NoteContext) => contextText(c),
} as const;

export const CRITIC_PROMPT = {
  system: [
    'You are a strict senior examiner reviewing a study note written for students. Find real problems; do not rewrite the note.',
    JSON_ONLY,
    'Shape: {"scores":{"accuracy":1-5,"grounded":1-5,"marksFit":1-5,"presentation":1-5,"clarity":1-5},"issues":[{"severity":"major|minor","where":"exam answer or a section","problem":"...","fix":"..."}],"verdict":"pass|fix"}',
    '- accuracy: every fact and figure is right. RECOMPUTE the exam answer: each amount, each total, both sides of every account, the balance sheet. Any arithmetic error is a major issue.',
    '- grounded: claims are backed by the cited textbook excerpts; anything not in them is a major issue.',
    "- marksFit: the exam answer earns full marks at this level, suits the board's allowed problem types, and can be written in the minutes given (about the word budget in the brief at most; clearly longer is a major issue). The study part explains without repeating the exam answer.",
    '- presentation: formats follow the presentation rules (journal narrations, ledger Dr/Cr, Schedule III, working notes, marks allotment adding up).',
    '- clarity: a student can follow it.',
    'verdict "fix" when there is any major issue or any score below 4; otherwise "pass".',
  ].join('\n'),
  user: (c: NoteContext, note: string) =>
    `${contextText(c)}\n\nThe note to review (JSON):\n${note}`,
} as const;

export const FIXER_PROMPT = {
  system: [
    WRITER_PROMPT.system,
    'You are given a draft and an examiner review. Return the corrected note: fix every major issue and the minor ones that are right; keep what is already correct.',
  ].join('\n'),
  user: (c: NoteContext, note: string, issues: string) =>
    `${contextText(c)}\n\nDraft (JSON; an older draft may have "workedExample" instead of "examAnswer": return the shape above):\n${note}\n\nExaminer review:\n${issues}`,
} as const;
