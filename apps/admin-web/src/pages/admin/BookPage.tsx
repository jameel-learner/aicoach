import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Badge, Button, Card, ErrorText, PageHeader, Table, Td } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { rehypePlugins, remarkPlugins } from '../../lib/markdown';
import {
  BOOK_STATUS,
  BUSY,
  PAGE_STATUS,
  docLabel,
  originalPageOf,
  pageRanges,
  type BookDetail,
  type PageStatus,
} from '../../lib/books';
import { usd } from '../../lib/credits';

interface PageView {
  pageNo: number;
  markdown: string | null;
  status: PageStatus;
  flags: string[] | null;
  error: string | null;
}

const PAGE_TONE: Record<PageStatus, string> = {
  pending: 'bg-surface-muted text-muted',
  parsed: 'bg-surface border-border',
  failed: 'bg-danger text-on-primary',
  approved: 'bg-accent text-on-primary',
  edited: 'bg-primary text-on-primary',
};

/** Admin: one textbook. Process, review each page against the PDF, publish, assign institutions. */
export function BookPage() {
  const { bookId } = useParams({ strict: false }) as { bookId: string };
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['book', bookId],
    queryFn: () => api<BookDetail>(`/admin/books/${bookId}`),
    refetchInterval: (s) =>
      s.state.data && BUSY.includes(s.state.data.book.status) ? 3000 : false,
  });
  const institutions = useQuery({
    queryKey: ['admin', 'institutions'],
    queryFn: () => api<{ id: string; name: string }[]>('/admin/institutions'),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['book', bookId] });
    void qc.invalidateQueries({ queryKey: ['books'] });
  };
  const action = useMutation({
    mutationFn: (what: 'parse' | 'publish') =>
      api(`/admin/books/${bookId}/${what}`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });

  const [pageNo, setPageNo] = useState<number | null>(null);
  const [showOnly, setShowOnly] = useState<'all' | 'flagged'>('all');
  const [mapped, setMapped] = useState<string[] | null>(null);
  const saveMapping = useMutation({
    mutationFn: () =>
      api(`/admin/books/${bookId}/institutions`, {
        method: 'PUT',
        body: { institutionIds: mapped ?? [] },
      }),
    onSuccess: () => {
      setMapped(null);
      refresh();
    },
  });

  if (q.error) return <ErrorText error={errorMessage(q.error)} />;
  if (!q.data) return <p className="text-muted">Loading…</p>;
  const { book, pages, parseCostUsdNano } = q.data;
  // A run that stopped (no progress for 10 min, e.g. the server restarted) can be continued.
  const stalled = q.data.stalled;
  const busy = BUSY.includes(book.status) && !stalled;
  const imported = book.source === 'imported';
  const notReady = pages.filter((p) => p.status === 'pending' || p.status === 'failed').length;
  const flagged = pages.filter((p) => p.status === 'failed' || (p.flags?.length ?? 0) > 0);
  const shown = showOnly === 'flagged' ? flagged : pages;
  const selectedIds = mapped ?? q.data.institutions.map((i) => i.id);
  // Stored pages restart at 1 when pages were removed before storing.
  const original = (n: number) => {
    const o = originalPageOf(n, book.removedPages);
    return o === n ? '' : ` (original page ${o})`;
  };

  return (
    <>
      <div className="mb-2 text-sm">
        <Link to="/admin/books" className="text-primary underline">
          Textbooks
        </Link>
      </div>
      <PageHeader
        title={book.title}
        subtitle={`${docLabel(book)} · ${book.pageCount} pages stored${book.removedPages?.length ? ` · ${book.removedPages.length} left out (see below)` : ''}${book.publishedVersion ? ` · published ${book.publishedVersion}` : ''}${imported ? ' · imported from the shared store' : ''}`}
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={BOOK_STATUS[book.status].tone}>{BOOK_STATUS[book.status].label}</Badge>
          {!imported && (
            <>
              <Button
                disabled={busy || action.isPending || (book.status === 'publishing' && !stalled)}
                onClick={() => action.mutate('parse')}
              >
                {stalled && book.status !== 'publishing'
                  ? `Continue reading (${notReady} left)`
                  : notReady === book.pageCount
                    ? 'Read all pages'
                    : `Read remaining pages (${notReady})`}
              </Button>
              <Button
                variant="secondary"
                disabled={
                  busy ||
                  action.isPending ||
                  notReady > 0 ||
                  (stalled && book.status !== 'publishing')
                }
                onClick={() => action.mutate('publish')}
              >
                {book.publishedVersion ? 'Publish new version' : 'Publish'}
              </Button>
              <span className="text-sm text-muted">
                OCR spent so far: {usd(parseCostUsdNano, 4)}
              </span>
            </>
          )}
        </div>
        {stalled && (
          <p className="mt-3 text-warning">
            {book.status === 'publishing' ? 'Publishing' : 'Reading'} stopped: no progress for over
            10 minutes (for example, the server was restarted). Pages already done are kept; press{' '}
            <strong>{book.status === 'publishing' ? 'Publish' : 'Continue reading'}</strong> to
            carry on.
          </p>
        )}
        {book.statusMessage && <p className="mt-3 text-warning">{book.statusMessage}</p>}
        <ErrorText error={action.error ? errorMessage(action.error) : null} />
        {!imported && (
          <p className="mt-3 text-sm text-muted">
            Reading continues in the background (you can leave this page). Publishing needs every
            page read; it indexes the book in the shared store for search and citations.
          </p>
        )}
      </Card>

      {!!book.removedPages?.length && (
        <div className="mt-6">
          <RemovedPages removed={book.removedPages} reasons={book.removedReasons} />
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_2fr]">
        <Card title="Pages">
          <div className="mb-3 flex gap-2 text-sm">
            <Button
              variant={showOnly === 'all' ? 'primary' : 'secondary'}
              className="min-h-9 px-3 text-sm"
              onClick={() => setShowOnly('all')}
            >
              All ({pages.length})
            </Button>
            <Button
              variant={showOnly === 'flagged' ? 'primary' : 'secondary'}
              className="min-h-9 px-3 text-sm"
              onClick={() => setShowOnly('flagged')}
            >
              Needs a look ({flagged.length})
            </Button>
          </div>
          <div className="grid grid-cols-6 gap-1 sm:grid-cols-8">
            {shown.map((p) => (
              <button
                key={p.pageNo}
                type="button"
                onClick={() => setPageNo(p.pageNo)}
                title={`Page ${p.pageNo}${original(p.pageNo)}: ${PAGE_STATUS[p.status]}${p.flags?.length ? ` (${p.flags.join(', ')})` : ''}`}
                aria-label={`Page ${p.pageNo}, ${PAGE_STATUS[p.status]}`}
                className={`min-h-9 rounded border text-sm ${PAGE_TONE[p.status]} ${
                  pageNo === p.pageNo ? 'ring-2 ring-primary' : ''
                } ${p.flags?.length ? 'underline decoration-warning decoration-2' : ''}`}
              >
                {p.pageNo}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            Grey: not read · white: read · green: approved · blue: edited · red: failed. Underlined:
            flagged as empty, short or garbled.
            {!!book.removedPages?.length &&
              ' Numbers are pages of the stored copy; hover a page (or open it) to see its page number in the original file.'}
          </p>
        </Card>

        {pageNo ? (
          <PageReview
            bookId={bookId}
            pageNo={pageNo}
            originalPage={originalPageOf(pageNo, book.removedPages)}
            readOnly={imported}
            onSaved={refresh}
            onNext={() => {
              const i = shown.findIndex((p) => p.pageNo === pageNo);
              setPageNo(shown[i + 1]?.pageNo ?? pageNo);
            }}
          />
        ) : (
          <Card title="Review">
            <p className="text-muted">Pick a page to compare the PDF with the text read from it.</p>
          </Card>
        )}
      </div>

      {book.kind === 'textbook' && (
        <div className="mt-6">
          <Card title="Institutions using this book">
            {!book.publishedVersion ? (
              <p className="text-muted">Publish (or import) the book first.</p>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  {institutions.data?.map((i) => (
                    <label key={i.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(i.id)}
                        onChange={(e) =>
                          setMapped(
                            e.target.checked
                              ? [...selectedIds, i.id]
                              : selectedIds.filter((x) => x !== i.id),
                          )
                        }
                      />
                      {i.name}
                    </label>
                  ))}
                </div>
                <Button
                  className="mt-3"
                  variant="secondary"
                  disabled={mapped === null || saveMapping.isPending}
                  onClick={() => saveMapping.mutate()}
                >
                  Save
                </Button>
                <ErrorText error={saveMapping.error ? errorMessage(saveMapping.error) : null} />
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function PageReview({
  bookId,
  pageNo,
  originalPage,
  readOnly,
  onSaved,
  onNext,
}: {
  bookId: string;
  pageNo: number;
  /** Page number in the original file (differs when pages were removed before storing). */
  originalPage: number;
  readOnly: boolean;
  onSaved: () => void;
  onNext: () => void;
}) {
  const q = useQuery({
    queryKey: ['book', bookId, 'page', pageNo],
    queryFn: () => api<PageView>(`/admin/books/${bookId}/pages/${pageNo}`),
  });
  const [text, setText] = useState('');
  useEffect(() => {
    setText(q.data?.markdown ?? '');
  }, [q.data]);
  const save = useMutation({
    mutationFn: (opts: { edit: boolean }) =>
      api(`/admin/books/${bookId}/pages/${pageNo}`, {
        method: 'PUT',
        body: opts.edit ? { markdown: text } : {},
      }),
    onSuccess: () => {
      void q.refetch();
      onSaved();
      onNext();
    },
  });
  const reparse = useMutation({
    mutationFn: () =>
      api(`/admin/books/${bookId}/pages/${pageNo}/reparse`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void q.refetch();
      onSaved();
    },
  });
  const changed = text !== (q.data?.markdown ?? '');

  return (
    <Card
      title={`Page ${pageNo}${originalPage !== pageNo ? ` · original page ${originalPage}` : ''}`}
    >
      {q.data && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <Badge>{PAGE_STATUS[q.data.status]}</Badge>
          {q.data.flags?.map((f) => (
            <Badge key={f} tone="warn">
              {f}
            </Badge>
          ))}
          {q.data.error && <span className="text-danger">{q.data.error}</span>}
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <iframe
          key={pageNo}
          title={`PDF page ${pageNo}`}
          src={`/api/admin/books/${bookId}/pages/${pageNo}/pdf`}
          className="h-[70vh] w-full rounded border border-border"
        />
        <textarea
          aria-label={`Text of page ${pageNo}`}
          className="h-[70vh] w-full rounded border border-border bg-surface p-3 font-mono text-sm text-text"
          value={text}
          readOnly={readOnly}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {!readOnly && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={save.isPending} onClick={() => save.mutate({ edit: changed })}>
            {changed ? 'Save edits & next' : 'Approve & next'}
          </Button>
          <Button variant="secondary" disabled={reparse.isPending} onClick={() => reparse.mutate()}>
            {reparse.isPending ? 'Reading…' : 'Read this page again'}
          </Button>
          <Button variant="secondary" onClick={onNext}>
            Skip
          </Button>
        </div>
      )}
      <ErrorText
        error={
          save.error ? errorMessage(save.error) : reparse.error ? errorMessage(reparse.error) : null
        }
      />
      <p className="mt-2 text-xs text-muted">
        The text is Markdown: tables use | columns |, headings start with #, formulas are LaTeX
        between $ signs. Fix only what's wrong; approving every page isn't required to publish.
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-primary">
          Show formatted (tables and formulas as students see them)
        </summary>
        <div className="prose-answer mt-2 overflow-x-auto rounded border border-border p-3 text-sm leading-relaxed [&_table]:my-2 [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_th]:border [&_th]:border-border [&_th]:bg-surface-muted [&_th]:px-2">
          <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
            {text}
          </ReactMarkdown>
        </div>
      </details>
    </Card>
  );
}

/**
 * Pages left out before storing, with why (Kannada versions, blank pages, repeated papers, cover
 * pages with personal details). Page numbers are those of the original file.
 */
function RemovedPages({
  removed,
  reasons,
}: {
  removed: number[];
  reasons: { pages: string; why: string }[] | null;
}) {
  const covered = new Set<number>();
  for (const r of reasons ?? [])
    for (const part of r.pages.split(',')) {
      const [a, b = a] = part.split('-').map((n) => Number(n.trim()));
      if (a && b) for (let p = a; p <= b; p++) covered.add(p);
    }
  const unexplained = removed.filter((p) => !covered.has(p));
  return (
    <Card title={`Pages left out before storing (${removed.length})`}>
      <p className="mb-3 text-sm text-muted">
        These pages of the original file were never stored or read (nothing was paid for them). Page
        numbers here are those of the original file.
      </p>
      <Table head={['Original pages', 'Why']} empty={false}>
        {(reasons ?? []).map((r) => (
          <tr key={r.pages}>
            <Td className="whitespace-nowrap font-medium">{r.pages}</Td>
            <Td>{r.why}</Td>
          </tr>
        ))}
        {unexplained.length > 0 && (
          <tr>
            <Td className="whitespace-nowrap font-medium">{pageRanges(unexplained)}</Td>
            <Td className="text-muted">No reason recorded</Td>
          </tr>
        )}
      </Table>
    </Card>
  );
}
