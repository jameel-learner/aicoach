import { answers, type Db } from '@aicoach/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Env, SessionUser } from '../env';
import { NOT_IN_TEXTBOOK, TUTOR_ANSWER } from '../llm/prompts';
import { runMeteredChat } from '../llm/run';
import { retrieve, type Source } from './retrieve';
import type { AskScope } from './scope';
import { embedder } from './store';

/**
 * Grounded answers (spec 1.1–1.4, architecture §3.6):
 *   cache (same scope, same or very similar question → stored answer, free, fast)
 *   → retrieve → answer from excerpts only, streamed, citing [S#] → verify citations → save variant.
 * "Force new" skips the cache and stores another variant.
 */

export interface Citation {
  n: number;
  bookId: string;
  bookTitle: string;
  page: number;
  section: string | null;
  snippet: string;
  /** False when the cited excerpt shares little with the sentence citing it (verifier). */
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

const SIMILAR = 0.92; // cosine similarity at which a stored answer is reused

export const normaliseQuestion = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export const scopeKeyOf = (scope: AskScope, profile = 'default') =>
  `${scope.books
    .map((b) => b.tag)
    .sort()
    .join(',')}|${profile}`;

type AnswerRow = typeof answers.$inferSelect;

/** Exact match first (no embedding needed: the fast path), then similar questions by cosine. */
async function findCached(
  db: Db,
  scopeKey: string,
  norm: string,
  getVector: () => Promise<number[]>,
) {
  const exact = await db
    .select()
    .from(answers)
    .where(and(eq(answers.scopeKey, scopeKey), eq(answers.questionNorm, norm)))
    .orderBy(desc(answers.variantNo))
    .get();
  if (exact) return exact;
  const vector = await getVector();
  const recent = await db
    .select()
    .from(answers)
    .where(eq(answers.scopeKey, scopeKey))
    .orderBy(desc(answers.createdAt))
    .limit(300);
  let best: AnswerRow | null = null;
  let bestScore = SIMILAR;
  for (const r of recent) {
    const s = cosine(vector, r.embedding);
    if (s >= bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

const words = (t: string) =>
  new Set((t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !/^\d+$/.test(w)));

/** Citation verifier: which sources are cited, and does each citing sentence overlap its source? */
export function verifyCitations(answer: string, sources: Source[]) {
  const cited = new Map<number, boolean>();
  const sentences = answer.split(/(?<=[.!?])\s+|\n+/);
  for (const s of sentences) {
    const ns = [...s.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1]));
    if (!ns.length) continue;
    const sw = words(s.replace(/\[S\d+\]/g, ''));
    for (const n of ns) {
      const src = sources.find((x) => x.n === n);
      if (!src) {
        cited.set(n, false);
        continue;
      }
      const cw = words(src.text);
      const overlap = sw.size ? [...sw].filter((w) => cw.has(w)).length / sw.size : 1;
      cited.set(n, (cited.get(n) ?? false) || overlap >= 0.2);
    }
  }
  const citations: Citation[] = [...cited.entries()]
    .map(([n, supported]) => {
      const src = sources.find((x) => x.n === n);
      return src
        ? {
            n,
            bookId: src.bookId,
            bookTitle: src.bookTitle,
            page: src.page,
            section: src.section,
            snippet: src.text.slice(0, 280),
            supported,
          }
        : null;
    })
    .filter((c): c is Citation => !!c)
    .sort((a, b) => a.n - b.n);
  // Markers pointing at sources that don't exist are removed from the answer.
  const unknown = [...cited.keys()].filter((n) => !sources.some((s) => s.n === n));
  let clean = answer;
  for (const n of unknown) clean = clean.replaceAll(`[S${n}]`, '');
  return { citations, answer: clean, hadInvalid: unknown.length > 0 };
}

export interface AskInput {
  question: string;
  forceNew?: boolean;
  /** Admin only: answer with this model (eval runs). */
  model?: string;
}

/** Answers a question, emitting events as it goes. Throws InsufficientCredits/LlmError before any delta. */
export async function answerQuestion(
  env: Env,
  db: Db,
  me: SessionUser,
  scope: AskScope,
  input: AskInput,
  emit: (e: AskEvent) => void,
) {
  const question = input.question.trim();
  const norm = normaliseQuestion(question);
  const scopeKey = scopeKeyOf(scope);
  const books = scope.books.map((b) => ({ id: b.id, title: b.title }));
  // Embedded at most once, and only when needed (not for an exact cache hit).
  let embedded: Promise<number[]> | undefined;
  const getVector = () =>
    (embedded ??= embedder(env)
      .embed([question])
      .then((v) => v[0]!));

  if (!input.forceNew) {
    const hit = await findCached(db, scopeKey, norm, getVector);
    if (hit) {
      await db
        .update(answers)
        .set({ hits: sql`${answers.hits} + 1` })
        .where(eq(answers.id, hit.id));
      emit({ type: 'meta', cached: true, books, context: scope.context.label });
      const citations = hit.citations as Citation[];
      emit({
        type: 'done',
        answerId: hit.id,
        answer: hit.answer,
        citations,
        notInBook: hit.notInBook,
        uncertain: !hit.notInBook && (!citations.length || citations.some((c) => !c.supported)),
        cached: true,
        variantNo: hit.variantNo,
        billedMicro: 0,
        model: me.role === 'admin' ? hit.model : null,
      });
      return;
    }
  }

  const vector = await getVector();
  const sources = await retrieve(
    env,
    db,
    question,
    scope.books.map((b) => b.tag),
    {
      questionVector: vector,
    },
  );
  emit({ type: 'meta', cached: false, books, context: scope.context.label });

  let answer: string;
  let model: string | null = null;
  let billed = 0;
  if (!sources.length) {
    answer = `${NOT_IN_TEXTBOOK} Your textbook doesn't seem to cover this.`;
  } else {
    // Hold back the first characters until we know whether it's a "not in textbook" reply.
    let head = '';
    let decided = false;
    const res = await runMeteredChat(env, db, {
      task: 'tutor_chat',
      payers: scope.payers,
      userId: me.id,
      maxTokens: 900,
      modelOverride: me.role === 'admin' ? input.model : undefined,
      messages: [
        { role: 'system', content: TUTOR_ANSWER.system(scope.subject) },
        { role: 'user', content: TUTOR_ANSWER.user(question, sources) },
      ],
      onDelta: (t) => {
        if (decided) return emit({ type: 'delta', text: t });
        head += t;
        if (
          head.length >= NOT_IN_TEXTBOOK.length ||
          !NOT_IN_TEXTBOOK.startsWith(head.trimStart())
        ) {
          decided = true;
          if (!head.trimStart().startsWith(NOT_IN_TEXTBOOK)) emit({ type: 'delta', text: head });
        }
      },
    });
    answer = res.content;
    model = res.model;
    billed = res.billedMicro;
  }

  const notInBook = answer.trimStart().startsWith(NOT_IN_TEXTBOOK);
  let text = notInBook ? answer.trimStart().slice(NOT_IN_TEXTBOOK.length).trim() : answer.trim();
  let citations: Citation[] = [];
  let invalid = false;
  if (!notInBook) {
    const v = verifyCitations(text, sources);
    citations = v.citations;
    text = v.answer;
    invalid = v.hadInvalid;
  }
  const uncertain =
    !notInBook && (!citations.length || invalid || citations.some((c) => !c.supported));

  const prev = await db
    .select({ v: sql<number>`coalesce(max(${answers.variantNo}), 0)` })
    .from(answers)
    .where(and(eq(answers.scopeKey, scopeKey), eq(answers.questionNorm, norm)))
    .get();
  const variantNo = Number(prev?.v ?? 0) + 1;
  const row = await db
    .insert(answers)
    .values({
      scopeKey,
      question,
      questionNorm: norm,
      embedding: vector,
      answer: text,
      citations,
      notInBook,
      variantNo,
      model,
      promptVersion: TUTOR_ANSWER.version,
      createdBy: me.id,
    })
    .returning({ id: answers.id })
    .get();

  emit({
    type: 'done',
    answerId: row.id,
    answer: text,
    citations,
    notInBook,
    uncertain,
    cached: false,
    variantNo,
    billedMicro: billed,
    model: me.role === 'admin' ? model : null,
  });
}
