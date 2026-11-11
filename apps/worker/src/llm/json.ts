import type { LlmTask } from '@aicoach/core';
import type { Db } from '@aicoach/db';
import type { z } from 'zod';
import type { Wallet } from '../credits/wallets';
import type { Env } from '../env';
import type { ChatMessage } from './openrouter';
import { runMeteredChat } from './run';

/**
 * One metered model call that must return JSON matching `schema`, with one retry that tells the
 * model what was wrong. Model-neutral: fences are stripped (some models wrap JSON in ```json),
 * JSON mode is requested, thinking is mapped per configured model.
 */
export async function askJson<S extends z.ZodTypeAny>(
  env: Env,
  db: Db,
  opts: {
    task: LlmTask;
    payers: Wallet[];
    userId: string | null;
    schema: S;
    system: string;
    user: string;
    maxTokens: number;
    thinking?: 'off' | 'low';
  },
): Promise<{ value: z.infer<S>; costUsdNano: number; model: string | null }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];
  let cost = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await runMeteredChat(env, db, {
      task: opts.task,
      payers: opts.payers,
      userId: opts.userId,
      maxTokens: opts.maxTokens,
      responseFormat: { type: 'json_object' },
      thinking: opts.thinking ?? 'off',
      messages,
    });
    cost += res.rawUsdNano;
    let problem: string;
    try {
      const raw = JSON.parse(
        res.content
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/```$/, ''),
      );
      const parsed = opts.schema.safeParse(raw);
      if (parsed.success) return { value: parsed.data, costUsdNano: cost, model: res.model };
      const issue = parsed.error.issues[0];
      problem = `${issue?.path.join('.')}: ${issue?.message}`;
    } catch (err) {
      problem = `not valid JSON (${err instanceof Error ? err.message : String(err)})`;
    }
    messages.push(
      { role: 'assistant', content: res.content.slice(0, 6000) },
      {
        role: 'user',
        content: `That reply did not match the required shape (${problem}). Reply again with the complete JSON object only.`,
      },
    );
  }
  throw new Error('The model did not return valid JSON after a retry');
}
