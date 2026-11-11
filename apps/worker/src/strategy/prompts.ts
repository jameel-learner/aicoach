/**
 * Prompts for compiling the exam strategy from board material (architecture §3.5, decision 9.5-2).
 * Every reply is one JSON object validated by the schemas in packages/core/src/strategy.ts.
 * Change a prompt → bump STRATEGY_PROMPT_VERSION (stored on each compile run).
 */

export const STRATEGY_PROMPT_VERSION = 'board_strategy@2';

const JSON_ONLY = 'Reply with ONE JSON object only (no Markdown fences, no commentary).';

export const STRUCTURE_PROMPT = {
  system: [
    'You read official board-exam documents (a blueprint and the instructions of a question bank) and extract the paper pattern exactly as stated. Never invent numbers.',
    JSON_ONLY,
    'Shape:',
    '{"academicYear":"2026-27","durationMin":180,"readingTimeMin":15,"maxMarks":80,"questionsOnPaper":32,',
    ' "parts":[{"part":"A","marksEach":1,"asked":20,"toAnswer":20,"typology":["MCQ 5","Fill in the blanks 5",...],"chapters":[1,2,...],"instructions":["..."]}, ...B, C, D],',
    ' "chapters":[{"no":1,"title":"...","hours":8,"marks":10,"partA":2,"partB":1,"partC":1,"partD":0,"note":null}, ...],',
    ' "problemSpecs":[{"chapter":1,"part":"C","allowed":["Preparation of Profit and Loss Appropriation A/c (5 items only) ...", "..."]}, ...],',
    ' "notes":["If 12 marks problem is asked on admission, then 6 marks should be asked on retirement and vice versa", ...]}',
    'Rules:',
    '- partA..partD are the NUMBER OF QUESTIONS of that part from the chapter (e.g. "1+1=2" → 2; "2 (A/R)+(D)" → 2; "1(A/R)" → 1; "-" → 0).',
    '- "asked" = questions printed in that part, "toAnswer" = how many the student must answer (e.g. "03/05" → toAnswer 3, asked 5).',
    '- Chapter numbers follow the blueprint table (1, 2, 3, …). Documents that number "Book II" chapters from 1 again must be mapped to the blueprint chapter with the same title (e.g. Book II Ch. 3 "Financial Statements of a Company" → the blueprint number of that chapter).',
    "- problemSpecs: the officially allowed problem types for 6-mark (part C) and 12-mark (part D) questions, per chapter, in the document's own words (shortened if long).",
  ].join('\n'),
  user: (docs: string) => `Documents:\n\n${docs}`,
} as const;

const TYPOLOGY_RULES = [
  'typology: mcq | fill_blank | match | true_false | expand | very_short | short_answer | problem.',
  '- "Match the following" is ONE question (typology match, marks = number of pairs, chapter null when the pairs come from different chapters).',
  '- Part B 2-mark theory or small-calculation questions are short_answer; 6 and 12 mark questions are problem.',
  'cognitive: remember | understand | apply | analyse (your judgement; HOTS → analyse).',
  'difficulty: easy | average | hots ONLY when the document labels it (e.g. "(Easy)", "(Average)", "(HOTS)"); otherwise null.',
  'topic: a short, specific name of what is tested, e.g. "Interest on drawings – product method", "Gaining ratio on retirement", "Redemption of debentures – lump sum".',
  'text: the question wording, at most 400 characters. Do not copy tables; describe them, e.g. "[table: balance sheet, 9 items]".',
  'page: the page number from the "--- page N ---" marker where the question starts.',
].join('\n');

export const PAPER_PROMPT = {
  system: (chapters: string) =>
    [
      'You tag every question of one board-exam question paper (English version) for an exam strategy.',
      JSON_ONLY,
      'Shape: {"questions":[{"qno":"1","part":"A","marks":1,"chapter":1,"topic":"...","typology":"mcq","cognitive":"remember","difficulty":null,"text":"...","page":2}],"endsIn":null}',
      `Chapters (use these numbers, match by title):\n${chapters}`,
      'Include every numbered question once, in order, from all parts (A, B, C, D). Ignore instructions, Kannada text and answer keys.',
      'part and marks come from the section headings, e.g. "PART – C … (3 × 6 = 18)" → part C, 6 marks each.',
      TYPOLOGY_RULES,
    ].join('\n'),
  user: (paper: string) => `Question paper:\n\n${paper}`,
} as const;

export const BANK_PROMPT = {
  system: (chapters: string) =>
    [
      "You tag the questions on a run of pages from a board's official question bank, for an exam strategy.",
      JSON_ONLY,
      'Shape: {"questions":[{"qno":"5","part":"A","marks":1,"chapter":3,"topic":"...","typology":"mcq","cognitive":"understand","difficulty":"easy","text":"...","page":41,"source":"bank","paperLabel":null,"examYear":null}],"endsIn":"Chapter 3, Part B questions"}',
      `Chapters (use these numbers, match by title):\n${chapters}`,
      'The bank has two kinds of pages:',
      '- chapter-wise questions (headings like "CHAPTER - 03", "PART - B", "Two Marks Questions"): source "bank", paperLabel null.',
      '- complete question papers (a cover with a code like "A1 – 2024", or a heading like "MODEL QUESTION PAPER-1 2024-25"): source "board_exam" for annual/board exam papers, "model_paper" for model question papers, "practice_paper" for practice papers; paperLabel = the code or title (e.g. "A1-2024", "Model paper 1 2024-25"); examYear = the exam year (e.g. 2024).',
      'You are told where the previous pages ended; continue from there (same chapter or paper) until a new heading or cover appears.',
      'You are also given the bank\'s own index: use it, with the printed page number in each page\'s footer (e.g. "189 | Page"), to tell which section a page belongs to: chapter-wise questions, board exam papers, model papers or practice papers. A paper ends where the index says the next section starts.',
      'A note after a chapter-wise question such as "(Exam-1)", "(Practice paper-2)" or "(2024)" only says where that question appeared: it stays source "bank" with paperLabel null.',
      'Skip "Key answer" sections, instructions, and index or cover pages without questions.',
      'endsIn: where the last page ends, e.g. "Chapter 7, Part C problems" or "paper A2-2024, Part D".',
      TYPOLOGY_RULES,
    ].join('\n'),
  user: (index: string, context: string | null, pages: string) =>
    `The bank's index and instructions:\n\n${index}\n\n${context ? `The previous pages ended in: ${context}\n\n` : ''}Pages:\n\n${pages}`,
} as const;

export const SCHEME_PROMPT = {
  system: [
    'You read an official scheme of evaluation (model answers with marks allotment) and extract, for each question number, the expected answer and how the marks are given.',
    JSON_ONLY,
    'Shape: {"answers":[{"qno":"22","answer":"Profit and Loss Appropriation A/c with interest on capital (Ravi 15,000; Kiran 10,000), commission, salary, interest on drawings; profit transferred 12,000 : 8,000","markSplit":"each item 1 mark: 6x1=6","markingPoints":[{"point":"Interest on capital","marks":1}, ...],"note":null}]}',
    '- answer: the expected answer in brief (at most 600 characters; for accounts, the key figures and totals).',
    '- markSplit: the marks allotment exactly as written (e.g. "1+1", "1+2+2+1", "each item 1 mark: 6x1=6"); null if none.',
    '- markingPoints: what earns marks, with the marks for each (at most 12 points).',
    '- note: alternatives the scheme accepts (e.g. "or any other two differences"), else null.',
    'Include every question number in the scheme once.',
  ].join('\n'),
  user: (qnos: string, scheme: string) =>
    `Question numbers in the paper: ${qnos}\n\nScheme of evaluation:\n\n${scheme}`,
} as const;

export const CONVENTIONS_PROMPT = {
  system: [
    'You study full-marks (centum) board-exam answer scripts in Accountancy and list the presentation conventions they follow, so a tutor can teach students to present answers the way examiners reward.',
    JSON_ONLY,
    'Shape: {"conventions":[{"format":"journal_entry","rule":"Columns Date | Particulars | L.F. | Debit ₹ | Credit ₹; each entry ends with a narration in brackets starting with Being …","example":"Bank A/c Dr 9,00,000 / To 10% Debenture Application & Allotment A/c 9,00,000 (Being application money received)","source":"script 1, Q30"}]}',
    'format: journal_entry | ledger_account | balance_sheet | profit_and_loss | cash_flow | ratio | comparative_common_size | working_notes | theory | general.',
    'Write 10 to 30 concrete, checkable rules (layout, headings, columns, order of items, totals, working notes, units, formula then substitution then answer, …). Ignore examiner ticks and personal details.',
  ].join('\n'),
  user: (scripts: string) => `Answer scripts:\n\n${scripts}`,
} as const;

export const TOPICS_PROMPT = {
  system: [
    'You merge question topics of one chapter into canonical topics, so the frequency of each topic can be counted.',
    JSON_ONLY,
    'Shape: {"topics":[{"name":"Interest on drawings – product method","items":["i3","i17","i42"]}]}',
    'Every item id must appear in exactly one topic. Use 5 to 25 topics; name them the way a teacher would (specific, not "Miscellaneous" unless unavoidable).',
  ].join('\n'),
  user: (chapter: string, lines: string) =>
    `Chapter: ${chapter}\n\nItems (id | part | marks | topic):\n${lines}`,
} as const;
