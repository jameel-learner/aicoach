import type { Env } from '../env';

/**
 * Minimal OpenRouter chat client (OpenAI-compatible). Every response carries the actual cost
 * (`usage.cost`, USD) which metering charges. Routed through Cloudflare AI Gateway when
 * AI_GATEWAY_URL is set; a gateway cache hit means OpenRouter charged nothing.
 */

export type ChatContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
      | { type: 'file'; file: { filename: string; file_data: string } }
      | { type: 'input_audio'; input_audio: { data: string; format: string } }
    >;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatContent;
}

export interface ChatRequest {
  models: string[]; // primary first, then fallbacks
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number | null;
  responseFormat?: { type: 'json_object' } | { type: 'json_schema'; json_schema: unknown };
  /** OpenRouter plugins, e.g. [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]. */
  plugins?: unknown[];
  /**
   * Stream the answer: called with each piece of text as it arrives. The cost still comes from
   * OpenRouter (the final stream chunk carries `usage.cost`).
   */
  onDelta?: (text: string) => void;
}

export interface ChatResult {
  generationId: string | null;
  model: string | null;
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number;
  cacheHit: boolean;
  /** Text OpenRouter's file-parser extracted from attached files (annotations), if any. */
  fileText: string | null;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export function openRouterBase(env: Pick<Env, 'AI_GATEWAY_URL'>) {
  return (env.AI_GATEWAY_URL || OPENROUTER_BASE).replace(/\/$/, '');
}

export async function chatCompletion(
  env: Pick<Env, 'OPENROUTER_API_KEY' | 'AI_GATEWAY_URL' | 'APP_URL'>,
  req: ChatRequest,
): Promise<ChatResult> {
  if (!env.OPENROUTER_API_KEY)
    throw new LlmError('AI is not configured (OPENROUTER_API_KEY missing)', 503);
  const [model, ...fallbacks] = req.models;
  const body: Record<string, unknown> = {
    model,
    messages: req.messages,
    max_tokens: req.maxTokens,
    usage: { include: true },
  };
  if (fallbacks.length) body.models = req.models;
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.responseFormat) body.response_format = req.responseFormat;
  if (req.plugins?.length) body.plugins = req.plugins;
  if (req.onDelta) body.stream = true;

  let res: Response;
  try {
    res = await fetch(`${openRouterBase(env)}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
        'http-referer': env.APP_URL,
        'x-title': 'AI Coach',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new LlmError(`Could not reach the AI provider: ${String(err)}`, 502);
  }

  if (
    req.onDelta &&
    res.ok &&
    (res.headers.get('content-type') ?? '').includes('text/event-stream')
  ) {
    return readStream(res, req.onDelta);
  }

  const text = await res.text();
  /** The fields we read from an OpenRouter chat completion (all optional: never trust the shape). */
  let data: {
    id?: unknown;
    model?: unknown;
    error?: { message?: string };
    choices?: {
      message?: {
        content?: unknown;
        annotations?: { type?: string; file?: { content?: { type?: string; text?: unknown }[] } }[];
      };
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: unknown };
  } | null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LlmError(`AI provider returned an unexpected response (${res.status})`, 502);
  }
  if (!res.ok || data?.error) {
    const msg = data?.error?.message ?? `AI provider error (${res.status})`;
    throw new LlmError(msg, res.ok ? 502 : res.status);
  }
  if (!data) throw new LlmError('AI provider returned an empty response', 502);
  const choice = data.choices?.[0];
  const cacheHit = (res.headers.get('cf-aig-cache-status') ?? '').toUpperCase() === 'HIT';
  return {
    generationId: typeof data.id === 'string' ? data.id : null,
    model: typeof data.model === 'string' ? data.model : null,
    content: typeof choice?.message?.content === 'string' ? choice.message.content : '',
    promptTokens: data.usage?.prompt_tokens ?? null,
    completionTokens: data.usage?.completion_tokens ?? null,
    costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : 0,
    cacheHit,
    fileText: fileTextOf(choice?.message?.annotations),
  };
}

interface StreamChunk {
  id?: unknown;
  model?: unknown;
  error?: { message?: string };
  choices?: { delta?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: unknown };
}

/**
 * Reads an OpenRouter SSE stream to the end (even if our own client has gone away, so the call is
 * always settled at OpenRouter's real cost). Comment lines (": OPENROUTER PROCESSING") are skipped.
 */
async function readStream(res: Response, onDelta: (text: string) => void): Promise<ChatResult> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let content = '';
  let id: string | null = null;
  let model: string | null = null;
  let usage: StreamChunk['usage'];
  const cacheHit = (res.headers.get('cf-aig-cache-status') ?? '').toUpperCase() === 'HIT';
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      return;
    }
    if (chunk.error) throw new LlmError(chunk.error.message ?? 'AI provider error mid-stream', 502);
    if (typeof chunk.id === 'string') id = chunk.id;
    if (typeof chunk.model === 'string') model = chunk.model;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) {
      content += delta;
      try {
        onDelta(delta);
      } catch {
        // The listener (our HTTP client) went away; keep reading so we can settle the cost.
      }
    }
    if (chunk.usage) usage = chunk.usage;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, nl).trim());
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) handle(buffer.trim());
  return {
    generationId: id,
    model,
    content,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    costUsd: typeof usage?.cost === 'number' ? usage.cost : 0,
    cacheHit,
    fileText: null,
  };
}

/** Joins the text parts of file annotations (file-parser output), dropping the <file> wrapper. */
function fileTextOf(
  annotations:
    { type?: string; file?: { content?: { type?: string; text?: unknown }[] } }[] | undefined,
): string | null {
  const parts = (annotations ?? [])
    .filter((a) => a.type === 'file')
    .flatMap((a) => a.file?.content ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string);
  if (!parts.length) return null;
  return parts
    .join('\n')
    .replace(/^<file name="[^"]*">\s*/i, '')
    .replace(/\s*<\/file>\s*$/i, '')
    .trim();
}

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
}

export async function fetchModels(
  env: Pick<Env, 'OPENROUTER_API_KEY'>,
): Promise<OpenRouterModel[]> {
  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: env.OPENROUTER_API_KEY ? { authorization: `Bearer ${env.OPENROUTER_API_KEY}` } : {},
  });
  if (!res.ok) throw new LlmError(`Could not load the model list (${res.status})`, 502);
  const data = (await res.json()) as { data?: OpenRouterModel[] };
  return data.data ?? [];
}

/** OpenRouter account balance in USD (total credits − total usage). */
export async function fetchAccountBalance(env: Pick<Env, 'OPENROUTER_API_KEY'>) {
  if (!env.OPENROUTER_API_KEY) throw new LlmError('OPENROUTER_API_KEY missing', 503);
  const res = await fetch(`${OPENROUTER_BASE}/credits`, {
    headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
  });
  if (!res.ok) throw new LlmError(`Could not read the OpenRouter balance (${res.status})`, 502);
  const data = (await res.json()) as { data?: { total_credits?: number; total_usage?: number } };
  const total = data.data?.total_credits ?? 0;
  const used = data.data?.total_usage ?? 0;
  return { totalUsd: total, usedUsd: used, balanceUsd: total - used };
}
