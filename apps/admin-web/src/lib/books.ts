import { BOARD_CATEGORIES } from '@aicoach/core';

export type BookStatus =
  'uploaded' | 'splitting' | 'parsing' | 'review' | 'publishing' | 'published' | 'failed';
export type PageStatus = 'pending' | 'parsed' | 'failed' | 'approved' | 'edited';

export interface Book {
  id: string;
  title: string;
  offeringId: string;
  edition: string | null;
  pageCount: number;
  status: BookStatus;
  statusMessage: string | null;
  publishedVersion: string | null;
  source: 'ingested' | 'imported';
  /** Board material feeds the exam strategy and is never searched by Ask (decision 9.5-2). */
  kind: 'textbook' | 'board_material';
  category: BoardCategory | null;
  academicYear: string | null;
  removedPages: number[] | null;
  removedReasons: { pages: string; why: string }[] | null;
}
export type BoardCategory = keyof typeof BOARD_CATEGORIES;

/**
 * Page numbers of the stored PDF restart at 1 after pages were removed before storing; this maps a
 * stored page back to its page number in the original file.
 */
export function originalPageOf(stored: number, removed: number[] | null): number {
  let orig = stored;
  for (const r of [...(removed ?? [])].sort((a, b) => a - b)) if (r <= orig) orig++;
  return orig;
}

/** [1,2,3,7] → "1-3, 7" */
export function pageRanges(pages: number[]): string {
  const out: [number, number][] = [];
  for (const p of [...pages].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && p === last[1] + 1) last[1] = p;
    else out.push([p, p]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/** "Board paper 2025-26" etc. for lists and headers. */
export const docLabel = (b: Pick<Book, 'kind' | 'category' | 'academicYear'>) =>
  b.kind === 'board_material' && b.category
    ? `${BOARD_CATEGORIES[b.category]} · ${b.academicYear ?? ''}`
    : 'Textbook';
export interface BookListItem extends Book {
  offering: string;
  pages: Partial<Record<PageStatus, number>>;
}
export interface SharedBook {
  bookId: string;
  version: string;
  title: string;
  pageCount: number;
  chunkCount: number;
  publishedAt: string;
  sourceEnv: string;
  localVersion: string | null;
  upToDate: boolean;
}
export interface PageSummary {
  pageNo: number;
  status: PageStatus;
  flags: string[] | null;
  error: string | null;
  costUsdNano: number;
  chars: number;
}
export interface BookDetail {
  book: Book;
  pages: PageSummary[];
  institutions: { id: string; name: string }[];
  parseCostUsdNano: number;
  /** Busy, but no progress for 10 minutes: the run stopped (e.g. the server restarted). */
  stalled: boolean;
}

export const BOOK_STATUS: Record<BookStatus, { label: string; tone?: 'good' | 'warn' }> = {
  uploaded: { label: 'Uploaded' },
  splitting: { label: 'Preparing pages…', tone: 'warn' },
  parsing: { label: 'Reading pages…', tone: 'warn' },
  review: { label: 'Ready for review', tone: 'warn' },
  publishing: { label: 'Publishing…', tone: 'warn' },
  published: { label: 'Published', tone: 'good' },
  failed: { label: 'Stopped' },
};

export const PAGE_STATUS: Record<PageStatus, string> = {
  pending: 'Not read yet',
  parsed: 'Read',
  failed: 'Failed',
  approved: 'Approved',
  edited: 'Edited',
};

export const pagesDone = (p: Partial<Record<PageStatus, number>>) =>
  (p.parsed ?? 0) + (p.approved ?? 0) + (p.edited ?? 0);

export const BUSY: BookStatus[] = ['splitting', 'parsing', 'publishing'];
