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
export type AskEvent =
  | { type: 'meta'; cached: boolean; books: { id: string; title: string }[]; context: string }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      answerId: string;
      answer: string;
      citations: Citation[];
      notInBook: boolean;
      uncertain: boolean;
      cached: boolean;
      variantNo: number;
      billedMicro: number;
      model: string | null;
    }
  | { type: 'error'; code: string; message: string };

export interface AskBody {
  question: string;
  classGroupId?: string;
  forceNew?: boolean;
}

export async function askStream(
  body: AskBody,
  onEvent: (e: AskEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/ask', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
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
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let i: number;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (block.startsWith('data: ')) onEvent(JSON.parse(block.slice(6)) as AskEvent);
    }
  }
}

/** Turns [S2] markers into links the Markdown renderer shows as page badges. */
export function withCitationLinks(answer: string, citations: Citation[]): string {
  return answer.replace(/\[S(\d+)\]/g, (m, n: string) => {
    const c = citations.find((x) => x.n === Number(n));
    return c ? ` [p. ${c.page}](#cite-${c.n})` : '';
  });
}
