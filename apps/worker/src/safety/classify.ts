import type { Env } from '../env';
import { checkRules, type SafetyLevel } from './rules';

/**
 * Safety classifier for a learner's free text (architecture §6.2, decision 9.6-5): rules first,
 * then a Workers AI guard model as a second net for what the rules pass. The model can only ADD a
 * distress verdict; if it is missing or fails, the rules' verdict stands. Not metered to users.
 */

export interface Classification {
  level: SafetyLevel;
  rule: string;
  detector: 'rules' | 'model';
}

const GUARD_MODEL = '@cf/meta/llama-guard-3-8b';
/** Llama Guard hazard category for suicide and self-harm. */
const SELF_HARM = 'S11';

async function guardSaysSelfHarm(env: Env, text: string): Promise<boolean> {
  if (!env.AI || env.APP_ENV === 'test') return false;
  try {
    const res = await Promise.race([
      env.AI.run(GUARD_MODEL as never, { messages: [{ role: 'user', content: text }] } as never),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    if (!res) return false; // too slow: don't hold the learner up; the rules already passed it
    // The model answers "safe" or "unsafe\nS11" (as text, or as { safe, categories }).
    const out = JSON.stringify((res as { response?: unknown }).response ?? res);
    return /unsafe|"safe":\s*false/i.test(out) && out.includes(SELF_HARM);
  } catch (err) {
    console.warn('safety guard model failed; using the rules only', err);
    return false;
  }
}

export async function classify(env: Env, text: string): Promise<Classification> {
  const byRule = checkRules(text);
  if (byRule.level === 'distress')
    return { level: 'distress', rule: byRule.rule!, detector: 'rules' };
  // Very short messages ("ok", "b", "3:2") carry nothing for the model to judge.
  if (text.trim().length >= 12 && (await guardSaysSelfHarm(env, text)))
    return { level: 'distress', rule: 'guard_self_harm', detector: 'model' };
  return { level: byRule.level, rule: byRule.rule ?? '', detector: 'rules' };
}
