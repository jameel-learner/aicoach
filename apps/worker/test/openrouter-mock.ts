import { vi } from 'vitest';

/**
 * Mock of OpenRouter for tests. Intercepts fetch to openrouter.ai; everything else passes through.
 * Tests control the reported cost, failures, gateway cache hits, and can inspect requests.
 */
export interface MockState {
  costUsd: number;
  fail: false | { status: number; message: string };
  cacheHit: boolean;
  delayMs: number;
  requests: { model: string; models?: string[]; max_tokens: number }[];
  balanceUsd: { total: number; used: number };
  /** file-parser plugin: the Markdown returned for an attached file (by filename, e.g. page-3.pdf). */
  parseText: (filename: string) => string;
  parsedFiles: string[];
  /** The assistant's reply (streamed in pieces when the request asks for a stream). */
  answer: string;
  /** Per-request reply (e.g. for the query-rewrite call); undefined → `answer`. */
  replyFor:
    ((body: { messages?: { role: string; content: unknown }[] }) => string | undefined) | null;
  /** System prompts of chat requests, in order (to see which prompts were called). */
  systems: string[];
  /** What OpenRouter's /generation endpoint reports later (reconciliation); default = costUsd. */
  generationCostUsd: number | null;
}

export const MODELS = [
  {
    id: 'google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    context_length: 1048576,
    pricing: { prompt: '0.0000003', completion: '0.0000025' },
    architecture: { input_modalities: ['file', 'image', 'text', 'audio', 'video'] },
    supported_parameters: ['response_format', 'max_tokens'],
  },
  {
    id: 'anthropic/claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5',
    context_length: 1000000,
    pricing: { prompt: '0.000002', completion: '0.00001' },
    architecture: { input_modalities: ['text', 'image', 'file'] },
    supported_parameters: ['response_format'],
  },
  {
    id: 'anthropic/claude-haiku-5.5',
    name: 'Claude Haiku 5.5',
    context_length: 1000000,
    pricing: { prompt: '0.0000001', completion: '0.0000005' },
    architecture: { input_modalities: ['text', 'image', 'file'] },
    supported_parameters: ['response_format'],
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o mini',
    context_length: 128000,
    pricing: { prompt: '0.00000015', completion: '0.0000006' },
    architecture: { input_modalities: ['text', 'image', 'file'] },
    supported_parameters: ['response_format'],
  },
  {
    id: 'some/other-model',
    name: 'Other',
    context_length: 8000,
    pricing: { prompt: '0.000001', completion: '0.000002' },
    architecture: { input_modalities: ['text'] },
    supported_parameters: [],
  },
];

const FILLER_MODELS = Array.from({ length: 150 }, (_, i) => ({
  id: `filler/model-${i}`,
  name: `Filler ${i}`,
  context_length: 4096,
  pricing: { prompt: '0.000001', completion: '0.000001' },
  architecture: { input_modalities: ['text'] },
  supported_parameters: [],
}));

export function installOpenRouterMock(): MockState {
  const state: MockState = {
    costUsd: 0.0001,
    fail: false,
    cacheHit: false,
    delayMs: 0,
    requests: [],
    balanceUsd: { total: 10, used: 2 },
    parseText: (filename) => `## Section of ${filename}

Parsed text of ${filename}.`,
    parsedFiles: [],
    answer: 'mock answer',
    replyFor: null,
    systems: [],
    generationCostUsd: null,
  };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://openrouter.ai/')) return realFetch(input, init);
      // 150 filler models: real syncs return 400+, which once broke D1's 100-parameter limit.
      if (url.endsWith('/models')) return Response.json({ data: [...MODELS, ...FILLER_MODELS] });
      if (url.endsWith('/credits')) {
        return Response.json({
          data: { total_credits: state.balanceUsd.total, total_usage: state.balanceUsd.used },
        });
      }
      if (url.includes('/generation?id=')) {
        return Response.json({ data: { total_cost: state.generationCostUsd ?? state.costUsd } });
      }
      if (url.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        state.requests.push({
          model: body.model,
          models: body.models,
          max_tokens: body.max_tokens,
        });
        const system = (body.messages ?? []).find((m: { role: string }) => m.role === 'system');
        state.systems.push(typeof system?.content === 'string' ? system.content : '');
        const reply = state.replyFor?.(body) ?? state.answer;
        if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
        if (state.fail) {
          return Response.json(
            { error: { message: state.fail.message } },
            { status: state.fail.status },
          );
        }
        if (body.stream) {
          const id = `gen-test-${state.requests.length}`;
          const pieces = reply.match(/[\s\S]{1,12}/g) ?? [];
          const lines = [
            ': OPENROUTER PROCESSING',
            ...pieces.map(
              (p) =>
                `data: ${JSON.stringify({ id, model: body.model, choices: [{ delta: { content: p } }] })}`,
            ),
            `data: ${JSON.stringify({ id, model: body.model, choices: [{ delta: {} }], usage: { prompt_tokens: 50, completion_tokens: 20, cost: state.costUsd } })}`,
            'data: [DONE]',
          ];
          return new Response(lines.join('\n\n') + '\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        // file-parser plugin: echo parsed text back as file annotations, like OpenRouter does.
        const files: string[] = body.plugins?.length
          ? (body.messages ?? []).flatMap((m: { content: unknown }) =>
              Array.isArray(m.content)
                ? m.content
                    .filter((p: { type: string }) => p.type === 'file')
                    .map((p: { file: { filename: string } }) => p.file.filename)
                : [],
            )
          : [];
        state.parsedFiles.push(...files);
        const annotations = files.map((f) => ({
          type: 'file',
          file: {
            hash: `hash-${f}`,
            name: f,
            content: [
              {
                type: 'text',
                text: `<file name="${f}">
${state.parseText(f)}
</file>`,
              },
            ],
          },
        }));
        return Response.json(
          {
            id: `gen-test-${state.requests.length}`,
            model: body.model,
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: reply,
                  ...(annotations.length ? { annotations } : {}),
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 5, cost: state.costUsd },
          },
          { headers: state.cacheHit ? { 'cf-aig-cache-status': 'HIT' } : {} },
        );
      }
      return new Response('not mocked', { status: 404 });
    },
  );
  return state;
}
