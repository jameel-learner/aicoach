import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorText, PageHeader } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { BOOK_STATUS, BUSY, PAGE_STATUS, type BookDetail, type PageStatus } from '../../lib/books';
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

  return (
    <>
      <div className="mb-2 text-sm">
        <Link to="/admin/books" className="text-primary underline">
          Textbooks
        </Link>
      </div>
      <PageHeader
        title={book.title}
        subtitle={`${book.pageCount} pages${book.publishedVersion ? ` · published ${book.publishedVersion}` : ''}${imported ? ' · imported from the shared store' : ''}`}
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
                title={`Page ${p.pageNo}: ${PAGE_STATUS[p.status]}${p.flags?.length ? ` (${p.flags.join(', ')})` : ''}`}
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
          </p>
        </Card>

        {pageNo ? (
          <PageReview
            bookId={bookId}
            pageNo={pageNo}
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
    </>
  );
}

function PageReview({
  bookId,
  pageNo,
  readOnly,
  onSaved,
  onNext,
}: {
  bookId: string;
  pageNo: number;
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
    <Card title={`Page ${pageNo}`}>
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
        The text is Markdown: tables use | columns |, headings start with #. Fix only what's wrong;
        approving every page isn't required to publish.
      </p>
    </Card>
  );
}
