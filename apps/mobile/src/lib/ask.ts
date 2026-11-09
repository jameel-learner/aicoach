import { fetch as expoFetch } from 'expo/fetch';
import { authClient } from './auth-client';
import { API_URL } from './config';

/** Client for POST /api/ask (Server-Sent Events). Mirrors AskEvent in apps/worker/src/content/answer.ts. */

export interface Citation {
  n: number;
  bookId: string;
  bookTitle: string;
  page: number;
  section: string | null;
  snippet: string;
  supported: boolean;
}
export type DoneEvent = {
  type: 'done';
  answerId: string;
  question: string;
  answer: string;
  citations: Citation[];
  notInBook: boolean;
  uncertain: boolean;
  cached: boolean;
  variantNo: number;
  billedMicro: number;
  model: string | null;
};
export type AskEvent =
  | {
      type: 'meta';
      cached: boolean;
      books: { id: string; title: string }[];
      context: string;
      /** The standalone question answered (a follow-up is rewritten, decision 9.5-1). */
      question: string;
    }
  | { type: 'delta'; text: string }
  | DoneEvent
  | { type: 'error'; code: string; message: string };

export interface HistoryTurn {
  question: string;
  answer: string;
}
/** The last 3 answered turns (standalone questions, shortened answers): context for follow-ups. */
export function historyOf(turns: { done?: { question: string; answer: string } }[]): HistoryTurn[] {
  return turns
    .flatMap((t) =>
      t.done ? [{ question: t.done.question, answer: t.done.answer.slice(0, 1500) }] : [],
    )
    .slice(-3);
}
const norm = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
/** True when the server answered a rewritten (standalone) version of what was typed. */
export const wasRewritten = (typed: string, answered: string) => norm(typed) !== norm(answered);

/** expo/fetch supports streamed response bodies (React Native's built-in fetch doesn't). */
export async function askStream(
  body: { question: string; enrolmentId?: string; forceNew?: boolean; history?: HistoryTurn[] },
  onEvent: (e: AskEvent) => void,
): Promise<void> {
  const cookie = await authClient.getCookie();
  let res: Awaited<ReturnType<typeof expoFetch>>;
  try {
    res = await expoFetch(`${API_URL}/api/ask`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ ...body, stream: true }),
      credentials: 'omit',
    });
  } catch {
    onEvent({
      type: 'error',
      code: 'network',
      message: "Can't reach AI Coach. Check your internet connection.",
    });
    return;
  }
  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* not JSON */
    }
    onEvent({ type: 'error', code: String(res.status), message });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (block.startsWith('data: ')) onEvent(JSON.parse(block.slice(6)) as AskEvent);
    }
  }
}
