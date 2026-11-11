/**
 * LLM tasks (architecture §6.5). Code always asks for a task; the Admin picks the model per task.
 */
export type Capability = 'text' | 'image' | 'audio' | 'file' | 'json';

export const LLM_TASKS = {
  playground: { label: 'Admin/Teacher playground', needs: ['text'] },
  tutor_chat: { label: 'Tutor chat (explain, hints, Socratic)', needs: ['text'] },
  query_rewrite: { label: 'Search query rewrite', needs: ['text', 'json'] },
  citation_verify: { label: 'Citation verifier', needs: ['text', 'json'] },
  content_generation: { label: 'Notes, cards, question bank', needs: ['text', 'json'] },
  grading: { label: 'Answer grading (marking scheme)', needs: ['text', 'image', 'json'] },
  vision_ocr: { label: 'Handwritten answer reading', needs: ['image'] },
  figure_description: { label: 'Textbook figure description', needs: ['image'] },
  pdf_parse: { label: 'Textbook PDF parsing', needs: ['file'] },
  speech_to_text: { label: 'Voice input', needs: ['audio'] },
  paper_builder: { label: 'Test paper builder', needs: ['text', 'json'] },
  eval_judge: { label: 'Evaluation judge (quality scores)', needs: ['text', 'json'] },
  board_analysis: { label: 'Board material analysis (exam strategy)', needs: ['text', 'json'] },
  content_review: {
    label: 'Learning material critic (checks generated notes, questions)',
    needs: ['text', 'json'],
  },
} as const satisfies Record<string, { label: string; needs: readonly Capability[] }>;

export type LlmTask = keyof typeof LLM_TASKS;
export const LLM_TASK_IDS = Object.keys(LLM_TASKS) as LlmTask[];

export function isLlmTask(v: unknown): v is LlmTask {
  return typeof v === 'string' && v in LLM_TASKS;
}

/** Decision 7: default for every task. */
export const DEFAULT_MODEL = 'google/gemini-2.5-flash';

/** Models offered in the Admin picker out of the box (slugs verified against OpenRouter /models). */
export const DEFAULT_SELECTABLE_MODELS = [
  'google/gemini-2.5-flash',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
  'openai/gpt-4o-mini',
] as const;

export function modelCapabilities(
  inputModalities: readonly string[],
  supportsJson: boolean,
): Capability[] {
  const caps = new Set<Capability>();
  for (const m of inputModalities)
    if (m === 'text' || m === 'image' || m === 'audio' || m === 'file') caps.add(m);
  if (supportsJson) caps.add('json');
  return [...caps];
}

/** Which required capabilities a model lacks for a task (empty = suitable). */
export function missingCapabilities(task: LlmTask, caps: readonly Capability[]): Capability[] {
  return LLM_TASKS[task].needs.filter((n) => !caps.includes(n));
}
