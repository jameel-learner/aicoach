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
}
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
