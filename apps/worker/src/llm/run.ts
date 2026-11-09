import { tokensCostNano, usdToNano, type LlmTask } from '@aicoach/core';
import type { Db } from '@aicoach/db';
import { feeFor, getFeeBps, getUsdInrPaise } from '../credits/ledger';
import { placeHold, releaseHold, settleHold } from '../credits/meter';
import type { Wallet } from '../credits/wallets';
import type { Env } from '../env';
import { usdNanoToBilledMicro } from '@aicoach/core';
import { chatCompletion, LlmError, type ChatMessage, type ChatRequest } from './openrouter';
import { getModels, getTaskConfig } from './registry';

/**
 * The single metered path for every LLM call (CLAUDE.md invariant).
 *   1. resolve the model(s) for the task from the Admin registry
 *   2. estimate the worst-case cost and place a hold on the paying wallet (spend order)
 *   3. call OpenRouter
 *   4. settle at OpenRouter's actual cost × (1 + fee); release the hold on failure
 */

// Used when a model's price isn't in the synced catalog yet: deliberately high so holds are safe.
const FALLBACK_PRICE_PICO = { prompt: 20_000_000, completion: 80_000_000 }; // $20 / $80 per M tokens

function estimatePromptTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else for (const part of m.content) chars += part.type === 'text' ? part.text.length : 4000;
  }
  // ~3 chars/token is conservative for English (and safer for Indic scripts), plus per-message overhead.
  return Math.ceil(chars / 3) + 16 * messages.length + 32;
}

export interface MeteredChatInput {
  task: LlmTask;
  messages: ChatMessage[];
  /** Paying wallets in spend order (e.g. class wallet, then the user's direct wallet). */
  payers: Wallet[];
  userId: string | null;
  maxTokens?: number;
  responseFormat?: ChatRequest['responseFormat'];
  plugins?: ChatRequest['plugins'];
  /** Non-token charges to add to the hold estimate (e.g. OCR at ~$0.002/page), nano-USD. */
  extraEstimateUsdNano?: number;
  /** Stream the answer text as it arrives (settled at the real cost when the stream ends). */
  onDelta?: (text: string) => void;
  /** Admin eval runs: use exactly this model (no registry fallbacks). */
  modelOverride?: string;
}

export interface MeteredChatResult {
  content: string;
  model: string | null;
  generationId: string | null;
  walletId: string;
  promptTokens: number | null;
  completionTokens: number | null;
  rawUsdNano: number;
  billedMicro: number;
  cacheHit: boolean;
  fileText: string | null;
}

export async function runMeteredChat(
  env: Env,
  db: Db,
  input: MeteredChatInput,
): Promise<MeteredChatResult> {
  const cfg = await getTaskConfig(db, input.task);
  const models = input.modelOverride
    ? [input.modelOverride]
    : [cfg.primaryModel, ...cfg.fallbackModels];
  const maxTokens = input.maxTokens ?? cfg.maxTokens ?? 1024;

  // Worst case over every model that might answer (fallbacks can cost more).
  const priced = await getModels(db, models);
  const promptTokens = estimatePromptTokens(input.messages);
  let rawEstimate = 0;
  for (const id of models) {
    const m = priced.find((p) => p.id === id);
    const pIn = m && m.pricePromptPico > 0 ? m.pricePromptPico : FALLBACK_PRICE_PICO.prompt;
    const pOut =
      m && m.priceCompletionPico > 0 ? m.priceCompletionPico : FALLBACK_PRICE_PICO.completion;
    rawEstimate = Math.max(
      rawEstimate,
      tokensCostNano(promptTokens, pIn) + tokensCostNano(maxTokens, pOut),
    );
  }
  const feeBps = await getFeeBps(db);
  const feeOf = (w: Wallet) => feeFor(w, feeBps);
  rawEstimate += input.extraEstimateUsdNano ?? 0;
  const maxFee = Math.max(...input.payers.map(feeOf));
  const usdInrPaise = await getUsdInrPaise(db);
  const estimate = Math.max(1, usdNanoToBilledMicro(rawEstimate, usdInrPaise, maxFee));

  const hold = await placeHold(db, input.payers, estimate, feeOf, usdInrPaise);
  const started = Date.now();
  try {
    const res = await chatCompletion(env, {
      models,
      messages: input.messages,
      maxTokens,
      temperature: cfg.temperature,
      responseFormat: input.responseFormat,
      plugins: input.plugins,
      onDelta: input.onDelta,
    });
    const settled = await settleHold(db, hold, {
      userId: input.userId,
      task: input.task,
      modelRequested: models[0]!,
      modelUsed: res.model,
      generationId: res.generationId,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      rawUsdNano: usdToNano(res.costUsd),
      cacheHit: res.cacheHit,
      latencyMs: Date.now() - started,
    });
    return {
      content: res.content,
      model: res.model,
      generationId: res.generationId,
      walletId: hold.wallet.id,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      rawUsdNano: settled.rawUsdNano,
      billedMicro: settled.billedMicro,
      cacheHit: res.cacheHit,
      fileText: res.fileText,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await releaseHold(
      db,
      hold,
      {
        userId: input.userId,
        task: input.task,
        modelRequested: models[0]!,
        modelUsed: null,
        generationId: null,
        promptTokens: null,
        completionTokens: null,
        latencyMs: Date.now() - started,
      },
      message,
    );
    throw err instanceof LlmError ? err : new LlmError(message, 502);
  }
}
