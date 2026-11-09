import { books, chunks, type Db } from '@aicoach/db';
import { eq, inArray } from 'drizzle-orm';
import type { Env } from '../env';
import { embedder, vectorStore } from './store';

/**
 * Hybrid retrieval (architecture §3.6): vector search (shared Vectorize) + keyword search (this
 * environment's FTS5), fused by reciprocal rank, then reranked (Workers AI bge-reranker-base).
 */

export interface Source {
  n: number; // [S<n>] in the prompt and the answer
  chunkId: string;
  bookId: string;
  bookTitle: string;
  page: number;
  section: string | null;
  text: string;
  score: number;
}

const RERANKER = '@cf/baai/bge-reranker-base';
const STOP = new Set(
  'the a an and or of to in on for is are was were be by with as at from that this what which how why when who whom whose does do did can could should would will shall may might explain define meaning give list state write about between into its it their there'.split(
    ' ',
  ),
);

/** FTS5 query: content words as quoted terms joined by OR (quotes neutralise FTS syntax). */
export function ftsQuery(question: string): string | null {
  const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
    (w) => w.length >= 3 && !STOP.has(w),
  );
  return words.length
    ? words
        .slice(0, 12)
        .map((w) => `"${w}"`)
        .join(' OR ')
    : null;
}

export async function retrieve(
  env: Env,
  db: Db,
  question: string,
  bookTags: string[],
  opts: { topK?: number; questionVector?: number[] } = {},
): Promise<Source[]> {
  const topK = opts.topK ?? 6;
  if (!bookTags.length) return [];
  const vector = opts.questionVector ?? (await embedder(env).embed([question]))[0]!;

  const [vecHits, ftsHits] = await Promise.all([
    vectorStore(env).query(vector, { topK: 20, books: bookTags }),
    (async () => {
      const q = ftsQuery(question);
      if (!q) return [] as string[];
      const placeholders = bookTags.map(() => '?').join(',');
      const res = await db.$client
        .prepare(
          `SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? AND book IN (${placeholders}) ORDER BY rank LIMIT 20`,
        )
        .bind(q, ...bookTags.slice(0, 20))
        .all<{ chunk_id: string }>();
      return res.results.map((r) => r.chunk_id);
    })(),
  ]);

  // Reciprocal rank fusion
  const fused = new Map<string, number>();
  vecHits.forEach((h, i) => fused.set(h.id, (fused.get(h.id) ?? 0) + 1 / (60 + i)));
  ftsHits.forEach((id, i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + i)));
  const ids = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([id]) => id);
  if (!ids.length) return [];

  const rows = await db
    .select({
      id: chunks.id,
      bookId: chunks.bookId,
      page: chunks.pageFrom,
      section: chunks.section,
      text: chunks.text,
      title: books.title,
    })
    .from(chunks)
    .innerJoin(books, eq(books.id, chunks.bookId))
    .where(inArray(chunks.id, ids));
  let ranked = ids
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is (typeof rows)[number] => !!r)
    .map((r) => ({ ...r, score: fused.get(r.id)! }));

  if (env.APP_ENV !== 'test' && env.AI && ranked.length > 1) {
    try {
      const res = (await env.AI.run(RERANKER, {
        query: question,
        contexts: ranked.map((r) => ({ text: r.section ? `${r.section}\n${r.text}` : r.text })),
      } as never)) as { response?: { id: number; score: number }[] };
      if (res.response?.length) {
        ranked = res.response
          .filter((x) => ranked[x.id])
          .map((x) => ({ ...ranked[x.id]!, score: x.score }))
          .sort((a, b) => b.score - a.score);
      }
    } catch (err) {
      console.error('rerank failed; using fused order', err);
    }
  }

  return ranked.slice(0, topK).map((r, i) => ({
    n: i + 1,
    chunkId: r.id,
    bookId: r.bookId,
    bookTitle: r.title,
    page: r.page,
    section: r.section,
    text: r.text,
    score: r.score,
  }));
}
