import type { MeResponse } from '@aicoach/core';
import { formatInr, mathToText } from '@aicoach/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '../lib/api';
import { rehypePlugins, remarkPlugins } from '../lib/markdown';
import {
  askStream,
  historyOf,
  wasRewritten,
  withCitationLinks,
  type AskEvent,
  type Citation,
} from '../lib/ask';

interface Turn {
  id: number;
  question: string;
  /** The standalone question the server answered (follow-ups are rewritten). */
  answering?: string;
  text: string;
  done?: Extract<AskEvent, { type: 'done' }>;
  handoff?: Extract<AskEvent, { type: 'handoff' }>;
  error?: string;
  pending: boolean;
}

/** Floating "Ask your textbook" button + right-hand drawer over any page (expandable). */
export function AskDrawer({ me }: { me: MeResponse }) {
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [classGroupId, setClassGroupId] = useState('');
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const isTeacher = me.user.role === 'teacher';

  const classes = useQuery({
    queryKey: ['teacher', 'classes'],
    queryFn: () => api<{ id: string; name: string }[]>('/teacher/classes'),
    enabled: open && isTeacher,
  });
  const scope = useQuery({
    queryKey: ['ask', 'scope', classGroupId],
    queryFn: () =>
      api<{ books: { id: string; title: string }[]; context: { label: string } }>(
        `/ask/scope${classGroupId ? `?classGroupId=${classGroupId}` : ''}`,
      ),
    enabled: open,
    retry: false,
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  // Block body: scrollIntoView returns a Promise in current browsers, and an effect must not
  // return anything but a cleanup function (React would call it → "is not a function").
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  const busy = turns.some((t) => t.pending);
  const update = (id: number, fn: (t: Turn) => Turn) =>
    setTurns((all) => all.map((t) => (t.id === id ? fn(t) : t)));

  // A follow-up ("why is it important?") goes with the last turns so it can be understood.
  // "Get a new answer" re-asks the already standalone question, so it needs no history.
  async function ask(q: string, forceNew = false) {
    const id = Date.now();
    const history = forceNew ? [] : historyOf(turns);
    setTurns((all) => [...all, { id, question: q, text: '', pending: true }]);
    abort.current = new AbortController();
    try {
      await askStream(
        {
          question: q,
          forceNew,
          classGroupId: classGroupId || undefined,
          history: history.length ? history : undefined,
        },
        (e) => {
          if (e.type === 'meta') update(id, (t) => ({ ...t, answering: e.question }));
          if (e.type === 'delta') update(id, (t) => ({ ...t, text: t.text + e.text }));
          if (e.type === 'done')
            update(id, (t) => ({ ...t, done: e, text: e.answer, pending: false }));
          if (e.type === 'handoff') update(id, (t) => ({ ...t, handoff: e, pending: false }));
          if (e.type === 'error') update(id, (t) => ({ ...t, error: e.message, pending: false }));
        },
        abort.current.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError')
        update(id, (t) => ({ ...t, error: 'Could not reach AI Coach', pending: false }));
    } finally {
      update(id, (t) => ({ ...t, pending: false }));
    }
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 inline-flex min-h-12 items-center gap-2 rounded-full bg-primary px-5 font-semibold text-on-primary shadow-lg hover:opacity-90"
        >
          <span aria-hidden>📖</span> Ask your textbook
        </button>
      )}
      {open && (
        <aside
          role="dialog"
          aria-label="Ask your textbook"
          className={`fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface shadow-2xl transition-[width] ${
            wide ? 'sm:w-[min(90vw,1000px)]' : 'sm:w-[440px]'
          }`}
        >
          <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h2 className="font-semibold">Ask your textbook</h2>
              <p className="truncate text-xs text-muted">
                {scope.error
                  ? 'No textbook is set up for you yet'
                  : scope.data
                    ? `Searching: ${scope.data.books.map((b) => b.title).join(', ') || 'no books'}`
                    : 'Loading…'}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                className="hidden min-h-9 rounded-lg border border-border px-3 text-sm sm:inline-block"
                onClick={() => setWide((w) => !w)}
                aria-label={wide ? 'Make narrower' : 'Expand'}
              >
                {wide ? '⇥ Narrow' : '⇤ Expand'}
              </button>
              <button
                type="button"
                className="min-h-9 rounded-lg border border-border px-3 text-sm"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </header>

          {isTeacher && (classes.data?.length ?? 0) > 0 && (
            <div className="border-b border-border px-4 py-2">
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted">Class</span>
                <select
                  className="min-h-9 flex-1 rounded-lg border border-border bg-surface px-2"
                  value={classGroupId}
                  onChange={(e) => setClassGroupId(e.target.value)}
                >
                  <option value="">My first class</option>
                  {classes.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {turns.length === 0 && (
              <div className="text-sm text-muted">
                <p className="mb-2">
                  Ask anything from your textbook. Answers cite the page they come from.
                </p>
                <p>Try: “What is goodwill?” or “Explain the revaluation account.”</p>
              </div>
            )}
            <div className="flex flex-col gap-6">
              {turns.map((t) => (
                <TurnView
                  key={t.id}
                  turn={t}
                  onRetry={() => void ask(t.done?.question ?? t.question, true)}
                  disabled={busy}
                />
              ))}
            </div>
            <div ref={bottom} />
          </div>

          <form
            className="flex gap-2 border-t border-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const q = question.trim();
              if (q.length < 3 || busy) return;
              setQuestion('');
              void ask(q);
            }}
          >
            <textarea
              aria-label="Your question"
              rows={2}
              placeholder="Type your question…"
              className="min-h-11 flex-1 resize-none rounded-lg border border-border bg-surface p-2 text-text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button
              type="submit"
              disabled={busy || question.trim().length < 3}
              className="min-h-11 rounded-lg bg-primary px-4 font-semibold text-on-primary disabled:opacity-50"
            >
              Ask
            </button>
          </form>
        </aside>
      )}
    </>
  );
}

function TurnView({
  turn,
  onRetry,
  disabled,
}: {
  turn: Turn;
  onRetry: () => void;
  disabled: boolean;
}) {
  const [openCite, setOpenCite] = useState<Citation | null>(null);
  const d = turn.done;
  const citations = d?.citations ?? [];
  return (
    <div>
      <p className="mb-2 rounded-lg bg-surface-muted px-3 py-2 font-medium">{turn.question}</p>
      {turn.answering && wasRewritten(turn.question, turn.answering) && (
        <p className="mb-2 text-xs text-muted">
          Answering: <span className="italic">{turn.answering}</span>
        </p>
      )}
      {turn.handoff ? (
        <div role="alert" className="rounded-lg border-2 border-primary px-3 py-3 text-[15px]">
          <p className="mb-1 font-semibold">{turn.handoff.title}</p>
          <p>{turn.handoff.text}</p>
          <ul className="my-2 list-disc pl-5">
            {turn.handoff.helplines.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
          {turn.handoff.told && <p className="text-sm text-muted">{turn.handoff.told}</p>}
        </div>
      ) : turn.error ? (
        <p role="alert" className="text-danger">
          {turn.error}
        </p>
      ) : (
        <div className="prose-answer text-[15px] leading-relaxed">
          {d?.notInBook && (
            <p className="mb-2 rounded-lg border border-warning px-3 py-2 text-sm">
              ⚠ Not in your textbook
            </p>
          )}
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={{
              a: ({ href, children }) => {
                const m = /^#cite-(\d+)$/.exec(href ?? '');
                if (!m) return <span>{children}</span>;
                const c = citations.find((x) => x.n === Number(m[1]));
                return (
                  <button
                    type="button"
                    onClick={() => setOpenCite(c ?? null)}
                    className={`mx-0.5 inline-flex items-center rounded-full px-2 text-xs font-semibold ${
                      c?.supported === false
                        ? 'border border-warning text-text'
                        : 'bg-primary text-on-primary'
                    }`}
                    aria-label={`Source: page ${c?.page}`}
                  >
                    {children}
                  </button>
                );
              },
              table: ({ children }) => (
                <div className="my-2 overflow-x-auto">
                  <table className="min-w-full border-collapse text-sm">{children}</table>
                </div>
              ),
              th: ({ children }) => (
                <th className="border border-border bg-surface-muted px-2 py-1 text-left">
                  {children}
                </th>
              ),
              td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
              ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
              ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
              p: ({ children }) => <p className="my-2">{children}</p>,
            }}
          >
            {d ? withCitationLinks(d.answer, citations) : turn.text || (turn.pending ? '…' : '')}
          </ReactMarkdown>
          {openCite && (
            <div className="mt-2 rounded-lg border border-border bg-surface-muted p-3 text-sm">
              <p className="font-semibold">
                {openCite.bookTitle} · page {openCite.page}
                {openCite.section ? ` · ${openCite.section}` : ''}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-muted">{mathToText(openCite.snippet)}…</p>
            </div>
          )}
          {d && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              {d.uncertain && !d.notInBook && (
                <span className="rounded-full border border-warning px-2 py-0.5 text-text">
                  ⚠ Check with your textbook: some points aren't clearly backed by it
                </span>
              )}
              {d.cached ? (
                <span>Saved answer · {d.billedMicro ? formatInr(d.billedMicro) : 'free'}</span>
              ) : (
                <span>{formatInr(d.billedMicro)}</span>
              )}
              {d.model && <span>· {d.model}</span>}
              <button
                type="button"
                disabled={disabled}
                onClick={onRetry}
                className="font-semibold text-primary underline disabled:opacity-50"
              >
                Get a new answer
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
