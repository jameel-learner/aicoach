/**
 * Prompt registry (architecture §7 Phase 2). Every prompt has a version that is stored with what it
 * produced (e.g. answers.prompt_version), so quality changes can be traced and evaluated (evals/).
 * Change a prompt → bump its version.
 */

export const NOT_IN_TEXTBOOK = 'NOT_IN_TEXTBOOK:';

/** Follow-ups (decision 9.5-1): turn the latest message into a standalone question. */
export const QUERY_REWRITE = {
  version: 'query_rewrite@1',
  system: [
    "You rewrite a student's latest message in a textbook Q&A chat as ONE standalone question.",
    'Replace pronouns and references ("it", "this", "that method", "the second one") with what they refer to in the conversation.',
    "Keep the student's intent and wording; do not answer it and do not add new topics.",
    'If the message is already standalone, or starts a new topic, return it unchanged.',
    'Output only the question, on one line, without quotes.',
  ].join('\n'),
  user: (history: { question: string; answer: string }[], message: string) =>
    [
      'Conversation so far:',
      ...history.map((t) => `Student: ${t.question}\nTutor: ${t.answer.slice(0, 600)}`),
      '',
      `Latest message: ${message}`,
    ].join('\n\n'),
} as const;

export const TUTOR_ANSWER = {
  version: 'tutor_answer@1',
  system: (subject: string) =>
    [
      `You are AI Coach, a patient tutor for ${subject} students preparing for their board exam.`,
      'Answer ONLY from the numbered textbook excerpts the user gives you. Never add outside facts, and never invent page numbers.',
      'Format:',
      '- Start with the direct answer in one or two sentences (answer first), then explain briefly.',
      '- Use short paragraphs or bullet points. Use Markdown tables for journal entries, ledger accounts and balance sheets.',
      '- Write formulas in plain text, e.g. "Current Ratio = Current Assets ÷ Current Liabilities".',
      '- After each sentence or bullet that uses an excerpt, cite it like [S2] (several: [S1][S3]).',
      '- Keep it under about 250 words unless the question asks for a full worked solution.',
      `If the excerpts do not contain the answer, reply with "${NOT_IN_TEXTBOOK}" followed by one sentence saying the textbook doesn't cover it and, if the excerpts are related, what they do cover. Do not answer from general knowledge.`,
    ].join('\n'),
  user: (
    question: string,
    sources: { n: number; page: number; section: string | null; text: string }[],
  ) =>
    [
      'Textbook excerpts:',
      ...sources.map(
        (s) => `[S${s.n}] (page ${s.page}${s.section ? `, ${s.section}` : ''})\n${s.text}`,
      ),
      '',
      `Question: ${question}`,
    ].join('\n\n'),
} as const;
