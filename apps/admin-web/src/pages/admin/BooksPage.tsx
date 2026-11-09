import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  Td,
} from '../../components/ui';
import { api, ApiRequestError, errorMessage } from '../../lib/api';
import { BOOK_STATUS, pagesDone, type BookListItem, type SharedBook } from '../../lib/books';
import { useOfferings } from '../../lib/queries';

/** Admin: textbooks. Upload + process here, or import books already processed elsewhere. */
export function BooksPage() {
  const qc = useQueryClient();
  const offerings = useOfferings();
  const list = useQuery({
    queryKey: ['books'],
    queryFn: () => api<BookListItem[]>('/admin/books'),
    // Keep progress moving while something is being processed.
    refetchInterval: (q) =>
      q.state.data?.some((b) => ['splitting', 'parsing', 'publishing'].includes(b.status))
        ? 3000
        : false,
  });
  const shared = useQuery({
    queryKey: ['books', 'shared'],
    queryFn: () => api<SharedBook[]>('/admin/books/shared'),
  });

  const [form, setForm] = useState({ title: '', offeringId: '', edition: '' });
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: async () => {
      const body = new FormData();
      body.set('file', file!);
      body.set('title', form.title);
      body.set('offeringId', form.offeringId);
      if (form.edition) body.set('edition', form.edition);
      const res = await fetch('/api/admin/books', {
        method: 'POST',
        credentials: 'include',
        body,
      });
      const data = (await res.json()) as { id?: string; error?: { message?: string } };
      if (!res.ok)
        throw new ApiRequestError(res.status, 'error', data.error?.message ?? 'Upload failed');
      return data as { id: string; pageCount: number };
    },
    onSuccess: () => {
      setForm({ ...form, title: '', edition: '' });
      setFile(null);
      void qc.invalidateQueries({ queryKey: ['books'] });
    },
  });
  const importBook = useMutation({
    mutationFn: (bookId: string) =>
      api(`/admin/books/shared/${bookId}/import`, { method: 'POST', body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['books'] }),
  });

  const onUpload = (e: FormEvent) => {
    e.preventDefault();
    upload.mutate();
  };

  return (
    <>
      <PageHeader
        title="Textbooks"
        subtitle="Upload a PDF, process it once, review the pages and publish. Published books are shared with the other environments (import them there)."
      />
      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card title="Books in this environment">
          <ErrorText error={list.error ? errorMessage(list.error) : null} />
          <Table head={['Book', 'Subject', 'Pages', 'Status']} empty={list.data?.length === 0}>
            {list.data?.map((b) => (
              <tr key={b.id}>
                <Td className="font-medium">
                  <Link
                    to="/admin/books/$bookId"
                    params={{ bookId: b.id }}
                    className="text-primary underline"
                  >
                    {b.title}
                  </Link>
                  {b.edition && <div className="text-xs text-muted">{b.edition}</div>}
                </Td>
                <Td>{b.offering}</Td>
                <Td>
                  {pagesDone(b.pages)} / {b.pageCount}
                  {!!b.pages.failed && (
                    <div className="text-xs text-danger">{b.pages.failed} failed</div>
                  )}
                </Td>
                <Td>
                  <Badge tone={BOOK_STATUS[b.status].tone}>{BOOK_STATUS[b.status].label}</Badge>
                  {b.publishedVersion && (
                    <div className="text-xs text-muted">
                      {b.publishedVersion} ·{' '}
                      {b.source === 'imported' ? 'imported' : 'processed here'}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Upload a textbook (PDF)">
          <form onSubmit={onUpload} className="flex flex-col gap-3">
            <Field label="PDF file">
              <Input
                type="file"
                accept="application/pdf"
                required
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </Field>
            <Field label="Title">
              <Input
                required
                placeholder="NCERT Accountancy Class 12 Part I"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </Field>
            <Field label="Board · class · subject">
              <Select
                required
                value={form.offeringId}
                onChange={(e) => setForm({ ...form, offeringId: e.target.value })}
              >
                <option value="">Choose…</option>
                {offerings.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.board.code} · {o.level.name} · {o.subject.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Edition (optional)">
              <Input
                placeholder="2024-25 reprint"
                value={form.edition}
                onChange={(e) => setForm({ ...form, edition: e.target.value })}
              />
            </Field>
            <ErrorText error={upload.error ? errorMessage(upload.error) : null} />
            <Button type="submit" disabled={upload.isPending || !file}>
              {upload.isPending ? 'Uploading…' : 'Upload'}
            </Button>
            <p className="text-sm text-muted">
              Uploading costs nothing. Processing (on the book's page) reads every page with OCR,
              about US$0.0022 per page, paid from the platform wallet.
            </p>
          </form>
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Shared content store: published books">
          <p className="mb-3 text-sm text-muted">
            Books published from any environment. Importing copies the processed pages into this
            environment's database: no re-processing, no cost.
          </p>
          <ErrorText error={shared.error ? errorMessage(shared.error) : null} />
          <Table
            head={['Book', 'Version', 'Pages · chunks', 'Here', '']}
            empty={shared.data?.length === 0}
          >
            {shared.data?.map((s) => (
              <tr key={s.bookId}>
                <Td className="font-medium">{s.title}</Td>
                <Td>
                  {s.version}
                  <div className="text-xs text-muted">
                    from {s.sourceEnv} · {new Date(s.publishedAt).toLocaleDateString('en-IN')}
                  </div>
                </Td>
                <Td>
                  {s.pageCount} · {s.chunkCount}
                </Td>
                <Td>
                  {s.upToDate ? (
                    <Badge tone="good">Up to date</Badge>
                  ) : s.localVersion ? (
                    <Badge tone="warn">Has {s.localVersion}</Badge>
                  ) : (
                    <Badge>Not imported</Badge>
                  )}
                </Td>
                <Td>
                  {!s.upToDate && (
                    <Button
                      variant="secondary"
                      className="min-h-9 px-3 text-sm"
                      disabled={importBook.isPending}
                      onClick={() => importBook.mutate(s.bookId)}
                      aria-label={`Import ${s.title}`}
                    >
                      {s.localVersion ? 'Update' : 'Import'}
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          <ErrorText error={importBook.error ? errorMessage(importBook.error) : null} />
        </Card>
      </div>
    </>
  );
}
