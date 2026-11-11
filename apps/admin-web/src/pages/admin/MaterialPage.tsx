import {
  RUBRIC,
  RUBRIC_LABELS,
  type AssetCheck,
  type AssetSource,
  type Critique,
  type SubjectMap,
} from '@aicoach/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
import {
  AssetBody,
  avg,
  STATUS,
  type AssetKind,
  type AssetStatus,
} from '../../components/material';
import { api, errorMessage } from '../../lib/api';
import { usd } from '../../lib/credits';
import { useOfferings } from '../../lib/queries';

/**
 * Admin: learning material generated from the approved exam strategy (decision 9.5-4).
 * Development uses Gemini; everything is regenerated with Claude Opus/Sonnet before production.
 */

type Status = AssetStatus;
type Kind = AssetKind;
type Tab = Kind | 'subject';
const TABS: { id: Tab; label: string }[] = [
  { id: 'note', label: 'Notes' },
  { id: 'cards', label: 'Cards & memory maps' },
  { id: 'questions', label: 'Question bank' },
  { id: 'graph', label: 'Concept graph' },
  { id: 'subject', label: 'Subject map' },
];
interface Overview {
  processingEnabled: boolean;
  strategy: { id: string; version: number } | null;
  chapters: {
    no: number;
    title: string;
    notes: number;
    generated: number;
    approved: number;
    rejected: number;
    estimateUsd: number;
    cards: { status: Status | null; approved: boolean; estimateUsd: number };
    questions: { sets: number[]; generated: number; approved: number; estimateUsd: number };
  }[];
  estimate: { usd: number; writer: string; critic: string };
  graph: { status: Status | null; approved: boolean; estimateUsd: number } | null;
  runs: {
    id: string;
    kind: Kind;
    status: 'running' | 'done' | 'failed';
    statusMessage: string | null;
    chapters: number[] | null;
    costUsdNano: number;
    createdAt: string;
    progress: { done: number; total: number; label: string } | null;
    stalled: boolean;
  }[];
}
interface AssetRow {
  id: string;
  slotKey: string;
  kind: Kind;
  version: number;
  chapter: number;
  topic: string;
  marks: number;
  status: Status;
  checks: AssetCheck[];
  critique: (Critique & { fixedAfter?: boolean }) | null;
  fixed: boolean;
  generator: string;
  reviewScore: number | null;
  teacherReviews: { count: number; avg: number } | null;
}
interface AssetDetail extends AssetRow {
  content: unknown;
  reviews: {
    reviewer: string;
    role: 'teacher' | 'admin';
    score: number;
    comment: string | null;
  }[];
  sources: AssetSource[];
  reviewNote: string | null;
  costUsdNano: number;
  target: { minWords: number; maxWords: number; shape: string };
}

export function MaterialPage() {
  const qc = useQueryClient();
  const offerings = useOfferings();
  const [offeringId, setOfferingId] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [chapter, setChapter] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('note');
  const kind: Kind = tab === 'subject' ? 'note' : tab;
  useEffect(() => {
    if (!offeringId && offerings.data?.length)
      setOfferingId(
        offerings.data.find((o) => o.id === 'offering_kseab_2puc_accountancy')?.id ??
          offerings.data[0]!.id,
      );
  }, [offerings.data, offeringId]);

  const overview = useQuery({
    queryKey: ['material', offeringId],
    queryFn: () => api<Overview>(`/admin/material?offeringId=${offeringId}`),
    enabled: !!offeringId,
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.status === 'running' && !r.stalled) ? 4000 : false,
  });
  const assets = useQuery({
    queryKey: ['material', 'assets', offeringId, chapter, kind],
    queryFn: () =>
      api<AssetRow[]>(
        `/admin/material/assets?offeringId=${offeringId}&kind=${kind}${chapter ? `&chapter=${chapter}` : ''}`,
      ),
    enabled: !!offeringId && tab !== 'subject',
    refetchInterval: () =>
      overview.data?.runs.some((r) => r.status === 'running' && !r.stalled) ? 6000 : false,
  });
  const summary = useQuery({
    queryKey: ['material', 'summary', offeringId],
    queryFn: () =>
      api<{
        reviewed: number;
        averageScore: number | null;
        teachers: { reviews: number; teachers: number; averageScore: number | null };
      }>(`/admin/material/review-summary?offeringId=${offeringId}`),
    enabled: !!offeringId,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['material'] });
  const generate = useMutation({
    mutationFn: () =>
      api('/admin/material/generate', {
        method: 'POST',
        body: {
          offeringId,
          kind,
          chapters: picked.length && kind !== 'graph' ? picked : undefined,
        },
      }),
    onSuccess: refresh,
  });
  const resume = useMutation({
    mutationFn: (id: string) =>
      api(`/admin/material/runs/${id}/continue`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });

  const o = overview.data;
  const busy = o?.runs.some((r) => r.status === 'running' && !r.stalled);
  const scoped = (o?.chapters ?? []).filter((c) => !picked.length || picked.includes(c.no));
  const count =
    kind === 'graph'
      ? 1
      : kind === 'cards'
        ? scoped.length
        : kind === 'questions'
          ? scoped.reduce((n, c) => n + c.questions.sets.length, 0)
          : scoped.reduce((n, c) => n + c.notes, 0);
  const cost = scoped.reduce(
    (n, c) =>
      n +
      (kind === 'graph'
        ? 0
        : kind === 'cards'
          ? c.cards.estimateUsd
          : kind === 'questions'
            ? c.questions.estimateUsd
            : c.estimateUsd),
    0,
  );
  const what =
    kind === 'graph'
      ? 'concept graph'
      : kind === 'cards'
        ? 'chapter card sets'
        : kind === 'questions'
          ? 'question sets'
          : 'notes';
  const totalCost = kind === 'graph' ? (o?.graph?.estimateUsd ?? 0) : cost;

  return (
    <>
      <PageHeader
        title="Learning material"
        subtitle="Notes per topic and marks level, and per chapter a memory map with quick cards, generated from the approved exam strategy, checked by a critic model and by code, then reviewed here. Development uses Gemini; all of it is regenerated with Claude Opus or Sonnet before production (decision 9.5-4)."
      />
      {offeringId && <SharePanel offeringId={offeringId} />}
      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => (
          <Button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            variant={tab === t.id ? 'primary' : 'secondary'}
            className="min-h-9 px-3 text-sm"
            onClick={() => {
              setTab(t.id);
              setOpenId(null);
            }}
          >
            {t.label}
          </Button>
        ))}
      </div>
      {summary.data && summary.data.teachers.reviews > 0 && (
        <p className="mb-3 text-sm text-muted">
          Teacher reviews: {summary.data.teachers.reviews} by {summary.data.teachers.teachers}{' '}
          teacher{summary.data.teachers.teachers === 1 ? '' : 's'}, average{' '}
          <strong>{summary.data.teachers.averageScore?.toFixed(2)}</strong> / 5 (Phase 3 target: 4
          or more)
        </p>
      )}
      {tab === 'subject' ? (
        <SubjectMapView offeringId={offeringId} />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_2fr]">
          <Card
            title={
              kind === 'cards'
                ? 'Generate cards & memory maps'
                : kind === 'questions'
                  ? 'Generate question sets'
                  : 'Generate notes'
            }
          >
            <Field label="Subject">
              <Select value={offeringId} onChange={(e) => setOfferingId(e.target.value)}>
                {offerings.data?.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.board.code} · {x.level.name} · {x.subject.name}
                  </option>
                ))}
              </Select>
            </Field>
            {!o?.strategy ? (
              <p className="mt-3 text-sm">Approve an exam strategy for this subject first.</p>
            ) : (
              <>
                <p className="mt-3 text-sm text-muted">
                  Following strategy version {o.strategy.version}. Writer {o.estimate.writer},
                  critic {o.estimate.critic} (change them in AI models: tasks “Notes, cards,
                  question bank” and “Learning material critic”).
                </p>
                {kind === 'graph' ? (
                  <p className="mt-3 text-sm">
                    One concept graph for the subject: which topics to learn before which, built
                    from the strategy's topics and the notes' summaries. Now:{' '}
                    {o.graph?.approved
                      ? 'approved'
                      : o.graph?.status
                        ? STATUS[o.graph.status].label.toLowerCase()
                        : 'not generated'}
                    .
                  </p>
                ) : (
                  <div className="mt-3 flex flex-col gap-1 text-sm">
                    {o.chapters.map((c) => (
                      <label key={c.no} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={picked.includes(c.no)}
                          onChange={(e) =>
                            setPicked(
                              e.target.checked
                                ? [...picked, c.no]
                                : picked.filter((x) => x !== c.no),
                            )
                          }
                        />
                        <span>
                          {c.no}. {c.title}{' '}
                          <span className="text-muted">
                            {kind === 'cards'
                              ? `(${c.cards.approved ? 'approved' : c.cards.status ? STATUS[c.cards.status].label.toLowerCase() : 'not generated'} · ≈ US$${c.cards.estimateUsd})`
                              : kind === 'questions'
                                ? `(${c.questions.sets.length ? `sets at ${c.questions.sets.join(', ')} marks` : 'no sets'} · ${c.questions.generated} generated · ${c.questions.approved} approved · ≈ US$${c.questions.estimateUsd})`
                                : `(${c.notes} notes · ${c.approved} approved · ≈ US$${c.estimateUsd})`}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                {o.processingEnabled ? (
                  <Button
                    className="mt-3"
                    disabled={busy || generate.isPending || count === 0}
                    onClick={() => generate.mutate()}
                  >
                    {busy
                      ? 'Generating…'
                      : `Generate ${count === 1 && kind === 'graph' ? 'the' : count} ${what}${picked.length || kind === 'graph' ? '' : ' (all chapters)'} (≈ US$${totalCost.toFixed(2)})`}
                  </Button>
                ) : (
                  <p className="mt-3 text-sm">
                    <strong>Generate on local, then import here.</strong>
                  </p>
                )}
                <p className="mt-2 text-xs text-muted">
                  Real cost on your OpenRouter account, from the platform wallet. Regenerating makes
                  a new version of each note; approved versions stay until a newer one is approved.
                </p>
              </>
            )}
            <ErrorText error={generate.error ? errorMessage(generate.error) : null} />

            <h3 className="mb-2 mt-6 font-semibold">Runs</h3>
            <ul className="flex flex-col gap-2 text-sm">
              {o?.runs.map((r) => (
                <li key={r.id} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        r.status === 'done' ? 'good' : r.status === 'running' ? 'warn' : undefined
                      }
                    >
                      {r.stalled ? 'Stopped' : r.status}
                    </Badge>
                    <span>
                      {r.kind === 'cards'
                        ? 'Cards'
                        : r.kind === 'questions'
                          ? 'Questions'
                          : 'Notes'}{' '}
                      · {r.chapters ? `chapters ${r.chapters.join(', ')}` : 'all chapters'}
                    </span>
                    <span className="text-muted">{usd(r.costUsdNano, 4)}</span>
                  </div>
                  {r.progress && r.status !== 'done' && (
                    <p className="mt-1 text-muted">
                      {r.progress.label} ({r.progress.done}/{r.progress.total})
                    </p>
                  )}
                  {r.statusMessage && <p className="mt-1 text-warning">{r.statusMessage}</p>}
                  {(r.status === 'failed' || r.stalled) && o?.processingEnabled && (
                    <Button
                      variant="secondary"
                      className="mt-2 min-h-9 px-3 text-sm"
                      disabled={resume.isPending}
                      onClick={() => resume.mutate(r.id)}
                    >
                      Continue
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <ErrorText error={resume.error ? errorMessage(resume.error) : null} />
          </Card>

          <div className="flex flex-col gap-6">
            <Card
              title={
                kind === 'cards'
                  ? 'Cards & memory maps'
                  : kind === 'questions'
                    ? 'Question bank'
                    : 'Notes'
              }
              actions={
                <Select
                  aria-label="Chapter"
                  className="min-h-9 w-auto"
                  value={chapter ?? ''}
                  onChange={(e) => setChapter(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">All chapters</option>
                  {o?.chapters.map((c) => (
                    <option key={c.no} value={c.no}>
                      {c.no}. {c.title}
                    </option>
                  ))}
                </Select>
              }
            >
              <Table
                head={[
                  'Ch',
                  kind === 'note' ? 'Topic' : kind === 'graph' ? 'Subject' : 'Chapter',
                  ...(kind === 'cards' || kind === 'graph' ? [] : ['Marks']),
                  'Status',
                  'Critic',
                  'Checks',
                  'Teachers',
                  'v',
                ]}
                empty={assets.data?.length === 0}
              >
                {assets.data?.map((a) => {
                  const bad = a.checks.filter((c) => !c.ok).length;
                  const score = avg(a.critique);
                  return (
                    <tr
                      key={a.id}
                      className={`cursor-pointer hover:bg-surface-muted ${openId === a.id ? 'bg-surface-muted' : ''}`}
                      onClick={() => setOpenId(a.id)}
                    >
                      <Td>{a.chapter}</Td>
                      <Td className="font-medium text-primary underline">{a.topic}</Td>
                      {kind !== 'cards' && kind !== 'graph' && <Td>{a.marks}</Td>}
                      <Td>
                        <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
                      </Td>
                      <Td>
                        {score?.toFixed(1) ?? '–'}
                        {a.fixed ? ' (fixed)' : ''}
                      </Td>
                      <Td>{bad ? `⚠ ${bad}` : '✓'}</Td>
                      <Td>
                        {a.teacherReviews
                          ? `${a.teacherReviews.avg.toFixed(1)} (${a.teacherReviews.count})`
                          : '–'}
                      </Td>
                      <Td>{a.version}</Td>
                    </tr>
                  );
                })}
              </Table>
            </Card>
            {openId && <AssetView key={openId} id={openId} onReviewed={refresh} />}
          </div>
        </div>
      )}
    </>
  );
}

interface VersionRow {
  id: string;
  version: number;
  status: Status;
  generator: string;
  critique: Critique | null;
  fixed: boolean;
  reviewScore: number | null;
  costUsdNano: number;
}

/** "google/gemini-2.5-flash" → "gemini-2.5-flash". */
const shortModel = (m: string | undefined) => (m ?? '').split('/').pop() ?? '';

function AssetView({ id: openedId, onReviewed }: { id: string; onReviewed: () => void }) {
  const [id, setId] = useState(openedId);
  const versions = useQuery({
    queryKey: ['material', 'versions', openedId],
    queryFn: () => api<VersionRow[]>(`/admin/material/assets/${openedId}/versions`),
  });
  const q = useQuery({
    queryKey: ['material', 'asset', id],
    queryFn: () => api<AssetDetail>(`/admin/material/assets/${id}`),
  });
  const [score, setScore] = useState('4');
  const [note, setNote] = useState('');
  const rewrite = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/admin/material/assets/${id}/rewrite`, {
        method: 'POST',
        body: { note },
      }),
    onSuccess: (r) => {
      setNote('');
      setId(r.id);
      void versions.refetch();
      onReviewed();
    },
  });
  const review = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api(`/admin/material/assets/${id}/review`, {
        method: 'POST',
        body: {
          decision,
          score: decision === 'approve' ? Number(score) : undefined,
          note: note || undefined,
        },
      }),
    onSuccess: () => {
      setNote('');
      void q.refetch();
      void versions.refetch();
      onReviewed();
    },
  });
  if (q.error) return <ErrorText error={errorMessage(q.error)} />;
  if (!q.data) return <p className="text-muted">Loading…</p>;
  const a = q.data;
  const [writer, critic, prompt] = a.generator.split('|');
  const newest = !versions.data || versions.data[0]?.id === a.id;

  return (
    <>
      {(versions.data?.length ?? 0) > 1 && (
        <Card title="Versions">
          <div className="flex flex-wrap gap-2">
            {versions.data!.map((v) => {
              const [w, cr] = v.generator.split('|');
              const s = avg(v.critique);
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setId(v.id)}
                  className={`rounded-lg border px-3 py-2 text-left text-xs ${
                    v.id === id ? 'border-primary bg-surface-muted' : 'border-border'
                  }`}
                >
                  <span className="font-semibold">v{v.version}</span> ·{' '}
                  {v.status === 'superseded' ? 'older' : STATUS[v.status].label}
                  <br />
                  writer {shortModel(w)}
                  {cr !== w ? `, critic ${shortModel(cr)}` : ''}
                  <br />
                  critic {s?.toFixed(1) ?? '–'}
                  {v.fixed ? ' (fixed)' : ''} · {usd(v.costUsdNano, 4)}
                </button>
              );
            })}
          </div>
          {a.status === 'superseded' && (
            <p className="mt-2 text-xs text-muted">
              Older version, kept for comparison (view only). Review the newest version.
            </p>
          )}
        </Card>
      )}
      <Card
        title={`${(a.content as { title?: string }).title ?? (a.kind === 'graph' ? `Concept graph: ${a.topic}` : `Chapter ${a.chapter}: ${a.topic}`)} · ${a.kind === 'cards' ? 'chapter cards' : a.kind === 'graph' ? 'subject' : `${a.marks}-mark ${a.kind === 'questions' ? 'questions' : 'note'}`} · version ${a.version}`}
        actions={<Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>}
      >
        <p className="mb-3 text-xs text-muted">
          Chapter {a.chapter} · written by {writer}, checked by {critic} ({prompt}) ·{' '}
          {usd(a.costUsdNano, 4)}
        </p>
        <AssetBody kind={a.kind} content={a.content} sources={a.sources} target={a.target} />
        <p className="mt-3 text-xs text-muted">
          Sources:{' '}
          {a.sources.map((s) => `p. ${s.page}${s.section ? ` (${s.section})` : ''}`).join(' · ') ||
            'none'}{' '}
          · {a.sources[0]?.bookTitle ?? ''}
        </p>
      </Card>

      <Card title="Checks">
        <ul className="mb-3 flex flex-col gap-1 text-sm">
          {a.checks.map((c) => (
            <li key={c.name} className={c.ok ? '' : 'text-warning'}>
              {c.ok ? '✓' : '⚠'} {c.name} <span className="text-muted">({c.detail})</span>
            </li>
          ))}
        </ul>
        {a.critique && (
          <>
            <h4 className="mb-1 font-semibold">
              Critic
              {a.critique.fixedAfter
                ? ' (on the first draft; the note above is the fixed version)'
                : ''}
            </h4>
            <div className="mb-2 flex flex-wrap gap-2 text-xs">
              {RUBRIC.map((k) => (
                <Badge key={k} tone={a.critique!.scores[k] >= 4 ? 'good' : 'warn'}>
                  {RUBRIC_LABELS[k]}: {a.critique!.scores[k]}
                </Badge>
              ))}
            </div>
            <ul className="list-disc pl-5 text-sm">
              {a.critique.issues.map((i, k) => (
                <li key={k}>
                  <strong>{i.severity}</strong> · {i.where}: {i.problem}{' '}
                  <span className="text-muted">→ {i.fix}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {newest && (a.status === 'draft' || a.status === 'rejected') && (
        <Card title="Your review">
          <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
            {a.status === 'draft' && (
              <Field label="Your score (rubric 1–5)">
                <Select value={score} onChange={(e) => setScore(e.target.value)}>
                  {[5, 4, 3, 2, 1].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Comment (needed to reject or rewrite)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {a.status === 'draft' && (
              <>
                <Button
                  disabled={review.isPending || rewrite.isPending}
                  onClick={() => review.mutate('approve')}
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  disabled={review.isPending || rewrite.isPending}
                  onClick={() => review.mutate('reject')}
                >
                  Reject
                </Button>
              </>
            )}
            <Button
              variant="secondary"
              disabled={review.isPending || rewrite.isPending || note.trim().length < 3}
              onClick={() => rewrite.mutate()}
            >
              {rewrite.isPending ? 'Rewriting… (up to a minute)' : 'Rewrite with my comment'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Rewrite: the note is rewritten following your comment and checked again; it comes back
            as a new version to review
            {a.status === 'draft' ? ', and this one is marked rejected with your comment' : ''}.
          </p>
          <ErrorText
            error={
              review.error
                ? errorMessage(review.error)
                : rewrite.error
                  ? errorMessage(rewrite.error)
                  : null
            }
          />
        </Card>
      )}
      {a.reviews.length > 0 && (
        <Card title="Teacher reviews">
          <ul className="flex flex-col gap-1 text-sm">
            {a.reviews.map((r, k) => (
              <li key={k}>
                <strong>{r.score}/5</strong> · {r.reviewer}
                {r.role === 'admin' ? ' (Admin)' : ''}
                {r.comment ? <span className="text-muted"> · {r.comment}</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {a.reviewNote && <p className="text-sm text-muted">Review note: {a.reviewNote}</p>}
    </>
  );
}

/** Subject-wise memory map (spec 2.4): from the approved strategy, no model call. */
interface Shared {
  canPublish: boolean;
  package: {
    version: number;
    publishedAt: string;
    publishedFrom: string;
    strategy: { version: number };
    books: { title: string; version: string | null }[];
    counts: Record<Kind, number>;
    chapters: number[];
    generators: string[];
    here: number;
    total: number;
    upToDate: boolean;
  } | null;
}

/**
 * Move approved material between environments (decision 9.5-7): LOCAL publishes the approved
 * strategy + approved material to the shared store; staging imports it. No model calls.
 */
function SharePanel({ offeringId }: { offeringId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['material', 'shared', offeringId],
    queryFn: () => api<Shared>(`/admin/material/shared?offeringId=${offeringId}`),
  });
  const done = () => void qc.invalidateQueries({ queryKey: ['material'] });
  const publish = useMutation({
    mutationFn: () =>
      api<{ version: number }>('/admin/material/publish', { method: 'POST', body: { offeringId } }),
    onSuccess: done,
  });
  const imp = useMutation({
    mutationFn: () =>
      api<{ imported: number; skipped: number; strategy: string; warnings: string[] }>(
        '/admin/material/import',
        { method: 'POST', body: { offeringId } },
      ),
    onSuccess: done,
  });
  const p = q.data?.package;
  const what = p
    ? [
        p.counts.note && `${p.counts.note} notes`,
        p.counts.cards && `${p.counts.cards} card decks`,
        p.counts.questions && `${p.counts.questions} question sets`,
        p.counts.graph && 'the concept graph',
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  return (
    <div className="mb-4">
      <Card title="Share with other environments">
        {q.data && (
          <div className="flex flex-col gap-2 text-sm">
            {p ? (
              <p>
                Latest package <strong>v{p.version}</strong> (published from {p.publishedFrom},{' '}
                {new Date(p.publishedAt).toLocaleString()}): strategy version {p.strategy.version},{' '}
                {what}
                {p.chapters.length
                  ? ` for chapter${p.chapters.length === 1 ? '' : 's'} ${p.chapters.join(', ')}`
                  : ''}
                . Cites {p.books.map((b) => `${b.title} ${b.version ?? ''}`).join(', ')}. Here:{' '}
                {p.upToDate ? (
                  <Badge tone="good">all {p.total} imported</Badge>
                ) : (
                  <Badge tone="warn">
                    {p.here} of {p.total} imported
                  </Badge>
                )}
              </p>
            ) : (
              <p className="text-muted">Nothing published for this subject yet.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {q.data.canPublish && (
                <Button disabled={publish.isPending} onClick={() => publish.mutate()}>
                  {publish.isPending ? 'Publishing…' : 'Publish approved material'}
                </Button>
              )}
              {p && !p.upToDate && (
                <Button
                  variant={q.data.canPublish ? 'secondary' : 'primary'}
                  disabled={imp.isPending}
                  onClick={() => imp.mutate()}
                >
                  {imp.isPending ? 'Importing…' : `Import v${p.version}`}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted">
              {q.data.canPublish
                ? 'Publishing puts the approved strategy and every approved item of this subject in the shared store as a new version (drafts, teacher reviews and costs stay here). Then import it on staging. No model calls.'
                : 'Material is generated and reviewed on local, then imported here. Import the textbooks it cites first (Books → Import). No model calls.'}
            </p>
            {publish.data && <p className="text-muted">Published v{publish.data.version}.</p>}
            {imp.data && (
              <p className="text-muted">
                Imported {imp.data.imported} item{imp.data.imported === 1 ? '' : 's'} (
                {imp.data.skipped} already here; strategy {imp.data.strategy}).
                {imp.data.warnings.map((w) => ` Note: ${w}.`).join('')}
              </p>
            )}
            <ErrorText
              error={
                publish.error
                  ? errorMessage(publish.error)
                  : imp.error
                    ? errorMessage(imp.error)
                    : null
              }
            />
          </div>
        )}
        <ErrorText error={q.error ? errorMessage(q.error) : null} />
      </Card>
    </div>
  );
}

function SubjectMapView({ offeringId }: { offeringId: string }) {
  const q = useQuery({
    queryKey: ['material', 'subject-map', offeringId],
    queryFn: () => api<SubjectMap>(`/admin/material/subject-map?offeringId=${offeringId}`),
    enabled: !!offeringId,
  });
  if (q.error) return <ErrorText error={errorMessage(q.error)} />;
  if (!q.data) return <p className="text-muted">Loading…</p>;
  const m = q.data;
  return (
    <Card title={m.subject}>
      <p className="mb-3 text-sm text-muted">
        Built from the approved exam strategy: each chapter's share of the blueprint marks, the
        parts it is asked in, and its most-asked topics across {m.papers} board papers. No model
        call.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {m.chapters.map((c) => (
          <div key={c.no} className="rounded-lg border border-border p-3 text-sm">
            <p className="font-semibold">
              {c.no}. {c.title}
            </p>
            <div className="my-2 h-2 rounded bg-surface-muted" aria-hidden>
              <div className="h-2 rounded bg-primary" style={{ width: `${c.share}%` }} />
            </div>
            <p className="text-xs text-muted">
              {c.marks} marks ({c.share}%) · parts {c.parts.join(', ') || '–'}
            </p>
            <ul className="mt-2 list-disc pl-5">
              {c.topTopics.map((t) => (
                <li key={t.name}>
                  {t.name}{' '}
                  <span className="text-muted">
                    ({t.examPapers} paper{t.examPapers === 1 ? '' : 's'})
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}
