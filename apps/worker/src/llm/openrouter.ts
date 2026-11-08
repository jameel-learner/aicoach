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
}

export interface ChatResult {
  generationId: string | null;
  model: string | null;
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number;
  cacheHit: boolean;
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

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LlmError(`AI provider returned an unexpected response (${res.status})`, 502);
  }
  if (!res.ok || data?.error) {
    const msg = data?.error?.message ?? `AI provider error (${res.status})`;
    throw new LlmError(msg, res.ok ? 502 : res.status);
  }
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
  };
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
