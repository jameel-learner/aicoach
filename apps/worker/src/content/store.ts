import type { Env } from '../env';

/**
 * Shared textbook content store (architecture §3.3, decision 9.4-1): ONE R2 bucket + ONE Vectorize
 * index used by LOCAL and STAGING. Code here only ever ADDS to it (no deletes).
 * Tests (APP_ENV=test) get in-memory fakes, so automated tests can never touch the real store.
 */

export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const EMBEDDING_DIMS = 1024;

export const keys = {
  original: (bookId: string) => `books/${bookId}/original.pdf`,
  page: (bookId: string, pageNo: number) =>
    `books/${bookId}/pages/${String(pageNo).padStart(4, '0')}.pdf`,
  pkg: (bookId: string, version: string, file: 'manifest.json' | 'pages.jsonl' | 'chunks.jsonl') =>
    `books/${bookId}/${version}/${file}`,
  /** One small file per published book (its latest manifest): what "Import" lists. */
  catalog: (bookId: string) => `catalog/${bookId}.json`,
  catalogPrefix: 'catalog/',
};

/** `<bookId>@<version>`: the Vectorize metadata value that scopes a query to one book version. */
export const bookTag = (bookId: string, version: string) => `${bookId}@${version}`;

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: { book: string; page: number; chunk: number };
}
export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}
export interface VectorStore {
  upsert(vectors: VectorRecord[]): Promise<void>;
  query(values: number[], opts: { topK: number; books: string[] }): Promise<VectorMatch[]>;
}
export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export class ContentStoreUnavailable extends Error {
  constructor(what: string) {
    super(`${what} is not configured for this environment (shared content store, docs §3.3)`);
  }
}

export function contentBucket(env: Pick<Env, 'CONTENT'>): R2Bucket {
  if (!env.CONTENT) throw new ContentStoreUnavailable('R2 bucket CONTENT');
  return env.CONTENT;
}

// ---------------------------------------------------------------- vectors

const memoryVectors = new Map<string, VectorRecord>();
/** Test helper: the in-memory fake index. */
export const testVectors = memoryVectors;

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export function vectorStore(env: Pick<Env, 'APP_ENV' | 'CONTENT_VECTORS'>): VectorStore {
  if (env.APP_ENV === 'test') {
    return {
      async upsert(vectors) {
        for (const v of vectors) memoryVectors.set(v.id, v);
      },
      async query(values, { topK, books }) {
        return [...memoryVectors.values()]
          .filter((v) => books.includes(v.metadata.book))
          .map((v) => ({ id: v.id, score: cosine(values, v.values), metadata: v.metadata }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
      },
    };
  }
  const index = env.CONTENT_VECTORS;
  if (!index) throw new ContentStoreUnavailable('Vectorize index CONTENT_VECTORS');
  return {
    async upsert(vectors) {
      // Vectorize accepts up to 1000 per call; keep requests small and predictable.
      for (let i = 0; i < vectors.length; i += 100) {
        await index.upsert(vectors.slice(i, i + 100));
      }
    },
    async query(values, { topK, books }) {
      const res = await index.query(values, {
        topK,
        filter: books.length === 1 ? { book: books[0]! } : { book: { $in: books } },
        returnMetadata: 'indexed',
      });
      return res.matches.map((m) => ({ id: m.id, score: m.score, metadata: m.metadata }));
    },
  };
}

// ---------------------------------------------------------------- embeddings

/** Deterministic fake embedding for tests: bag of hashed words, so similar texts score higher. */
function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(64).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    v[h % 64]! += 1;
  }
  return v;
}

export function embedder(env: Pick<Env, 'APP_ENV' | 'AI'>): Embedder {
  if (env.APP_ENV === 'test') {
    return { model: 'test-fake', embed: async (texts) => texts.map(fakeEmbedding) };
  }
  const ai = env.AI;
  if (!ai) throw new ContentStoreUnavailable('Workers AI binding AI');
  return {
    model: EMBEDDING_MODEL,
    async embed(texts) {
      const out: number[][] = [];
      // Small batches keep each Workers AI call well inside its input limits.
      for (let i = 0; i < texts.length; i += 20) {
        const res = (await ai.run(EMBEDDING_MODEL, { text: texts.slice(i, i + 20) })) as {
          data?: number[][];
        };
        if (!res.data) throw new Error('Embedding model returned no vectors');
        out.push(...res.data);
      }
      return out;
    },
  };
}
