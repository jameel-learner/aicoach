import {
  BOARD_CATEGORIES,
  TYPOLOGY_LABELS,
  type ExamStrategy,
  type Part,
  type TopicStat,
} from '@aicoach/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';
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
import { api, errorMessage } from '../../lib/api';
import { usd } from '../../lib/credits';
import { useOfferings } from '../../lib/queries';

/**
 * Admin: exam strategy compiled from the board material (architecture §3.5, decision 9.5-2).
 * Compile (LOCAL) → review the draft (pattern, checks, chapters, topics, marking, presentation) → approve.
 */

type RunStatus = 'compiling' | 'draft' | 'approved' | 'superseded' | 'failed';
interface RunRow {
  id: string;
  version: number;
  status: RunStatus;
  statusMessage: string | null;
  progress: { step: string; done: number; total: number; label: string } | null;
  costUsdNano: number;
  createdAt: string;
  approvedAt: string | null;
  stalled: boolean;
}
interface Overview {
  processingEnabled: boolean;
  documents: { id: string; title: string; category: keyof typeof BOARD_CATEGORIES | null }[];
  estimate: { usd: number };
  runs: RunRow[];
}
interface RunDetail extends RunRow {
  strategy: ExamStrategy | null;
  reviewNote: string | null;
}
interface Item {
  id: string;
  bookTitle: string;
  page: number | null;
  source: string;
  paperLabel: string | null;
  qno: string;
  part: Part | null;
  marks: number | null;
  chapter: number | null;
  topic: string;
  topicGroup: string | null;
  typology: keyof typeof TYPOLOGY_LABELS;
  difficulty: string | null;
  text: string;
  answer: string | null;
  markSplit: string | null;
}

const STATUS: Record<RunStatus, { label: string; tone?: 'good' | 'warn' }> = {
  compiling: { label: 'Compiling…', tone: 'warn' },
  draft: { label: 'Draft: review it', tone: 'warn' },
  approved: { label: 'Approved', tone: 'good' },
  superseded: { label: 'Superseded' },
  failed: { label: 'Stopped' },
};
const SOURCE_LABEL: Record<string, string> = {
  board_exam: 'Board exam',
  model_paper: 'Model paper',
  practice_paper: 'Practice paper',
  bank: 'Question bank',
};

export function StrategyPage() {
  const qc = useQueryClient();
  const offerings = useOfferings();
  const [offeringId, setOfferingId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (!offeringId && offerings.data?.length)
      setOfferingId(
        offerings.data.find((o) => o.id === 'offering_kseab_2puc_accountancy')?.id ??
          offerings.data[0]!.id,
      );
  }, [offerings.data, offeringId]);

  const overview = useQuery({
    queryKey: ['strategy', offeringId],
    queryFn: () => api<Overview>(`/admin/strategy?offeringId=${offeringId}`),
    enabled: !!offeringId,
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.status === 'compiling' && !r.stalled) ? 4000 : false,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['strategy'] });
  const compile = useMutation({
    mutationFn: () => api('/admin/strategy/compile', { method: 'POST', body: { offeringId } }),
    onSuccess: refresh,
  });
  const resume = useMutation({
    mutationFn: (id: string) => api(`/admin/strategy/${id}/continue`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });

  const runs = overview.data?.runs ?? [];
  const shownId = openId ?? runs.find((r) => r.status !== 'superseded')?.id ?? null;
  const busy = runs.some((r) => r.status === 'compiling' && !r.stalled);
  const docs = overview.data?.documents ?? [];
  const byCategory = docs.reduce<Record<string, number>>((m, d) => {
    const k = d.category ?? 'other';
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

  return (
    <>
      <PageHeader
        title="Exam strategy"
        subtitle="Compiled from the published board material (blueprint, papers, schemes of evaluation, question bank, centum scripts). Review the draft, then approve it: notes, practice and mock papers follow the approved strategy."
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_2fr]">
        <Card title="Compile">
          <Field label="Subject">
            <Select value={offeringId} onChange={(e) => setOfferingId(e.target.value)}>
              {offerings.data?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.board.code} · {o.level.name} · {o.subject.name}
                </option>
              ))}
            </Select>
          </Field>
          <p className="mt-3 text-sm">
            {docs.length} published board documents
            {docs.length > 0 &&
              `: ${Object.entries(byCategory)
                .map(
                  ([k, n]) =>
                    `${n} ${BOARD_CATEGORIES[k as keyof typeof BOARD_CATEGORIES]?.toLowerCase() ?? k}`,
                )
                .join(', ')}`}
            .
          </p>
          {overview.data?.processingEnabled === false ? (
            <p className="mt-3 text-sm">
              <strong>Compile on local, then import here.</strong>
            </p>
          ) : (
            <>
              <Button
                className="mt-3"
                disabled={busy || compile.isPending || docs.length === 0}
                onClick={() => compile.mutate()}
              >
                {busy
                  ? 'Compiling…'
                  : `Compile strategy (≈ US$${overview.data?.estimate.usd ?? '…'})`}
              </Button>
              <p className="mt-2 text-xs text-muted">
                Real cost on your OpenRouter account (task “Board material analysis”, default
                gemini-2.5-flash), paid from the platform wallet. Takes about 10 to 20 minutes; keep
                the local server running. A stopped run can be continued without paying again for
                finished steps.
              </p>
            </>
          )}
          <ErrorText error={compile.error ? errorMessage(compile.error) : null} />

          <h3 className="mb-2 mt-6 font-semibold">Versions</h3>
          {runs.length === 0 && <p className="text-sm text-muted">None yet.</p>}
          <ul className="flex flex-col gap-2">
            {runs.map((r) => (
              <li
                key={r.id}
                className={`rounded-lg border border-border p-3 text-sm ${shownId === r.id ? 'ring-2 ring-primary' : ''}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="font-semibold text-primary underline"
                    onClick={() => setOpenId(r.id)}
                  >
                    Version {r.version}
                  </button>
                  <Badge tone={STATUS[r.status].tone}>
                    {r.stalled ? 'Stopped (no progress for 10 min)' : STATUS[r.status].label}
                  </Badge>
                  <span className="text-muted">{usd(r.costUsdNano, 4)}</span>
                </div>
                {r.status === 'compiling' && r.progress && (
                  <p className="mt-1 text-muted">
                    {r.progress.label} ({r.progress.done}/{r.progress.total})
                  </p>
                )}
                {r.statusMessage && <p className="mt-1 text-warning">{r.statusMessage}</p>}
                {(r.status === 'failed' || r.stalled) && overview.data?.processingEnabled && (
                  <Button
                    variant="secondary"
                    className="mt-2 min-h-9 px-3 text-sm"
                    disabled={resume.isPending}
                    onClick={() => resume.mutate(r.id)}
                  >
                    Continue compiling
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <ErrorText error={resume.error ? errorMessage(resume.error) : null} />
        </Card>

        {shownId ? (
          <RunView id={shownId} onChanged={refresh} />
        ) : (
          <Card title="Strategy">
            <p className="text-muted">Compile a strategy to see it here.</p>
          </Card>
        )}
      </div>
    </>
  );
}

function RunView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const run = useQuery({
    queryKey: ['strategy', 'run', id],
    queryFn: () => api<RunDetail>(`/admin/strategy/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'compiling' ? 4000 : false),
  });
  if (run.error) return <ErrorText error={errorMessage(run.error)} />;
  if (!run.data) return <p className="text-muted">Loading…</p>;
  const s = run.data.strategy;
  if (!s)
    return (
      <Card title={`Version ${run.data.version}`}>
        <p className="text-muted">
          {run.data.status === 'compiling'
            ? `${run.data.progress?.label ?? 'Starting'} (${run.data.progress?.done ?? 0}/${run.data.progress?.total ?? '…'})`
            : (run.data.statusMessage ?? 'No strategy in this version.')}
        </p>
      </Card>
    );
  return <StrategyView run={run.data} s={s} onChanged={onChanged} />;
}

function StrategyView({
  run,
  s,
  onChanged,
}: {
  run: RunDetail;
  s: ExamStrategy;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [chapter, setChapter] = useState<number | null>(null);
  const approve = useMutation({
    mutationFn: () =>
      api(`/admin/strategy/${run.id}/approve`, {
        method: 'POST',
        body: { note: note || undefined },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['strategy'] });
      onChanged();
    },
  });
  const failed = s.checks.filter((c) => !c.ok);

  return (
    <div className="flex flex-col gap-6">
      <Card
        title={`${s.board} ${s.className} ${s.subject} · ${s.academicYear ?? ''} · version ${run.version}`}
        actions={<Badge tone={STATUS[run.status].tone}>{STATUS[run.status].label}</Badge>}
      >
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Paper" value={`${s.durationMin / 60} h + ${s.readingTimeMin} min reading`} />
          <Stat
            label="Max marks"
            value={`${s.maxMarks} (${s.questionsOnPaper ?? '?'} questions)`}
          />
          <Stat label="Time per mark" value={`${s.minutesPerMark} min`} />
          <Stat
            label="Analysed"
            value={`${s.exams.papers} board papers (${s.exams.years.join(', ')}), ${s.modelPapers} model papers`}
          />
        </div>
        <p className="mt-3 text-xs text-muted">
          {s.stats.questions} questions tagged ({s.stats.examItems} from board papers,{' '}
          {s.stats.bankItems} from the question bank), {s.stats.withMarking} with marking from the
          schemes of evaluation · cost {usd(run.costUsdNano, 4)}
        </p>
      </Card>

      <Card
        title={`Checks against the blueprint (${s.checks.length - failed.length}/${s.checks.length} pass)`}
      >
        <ul className="flex flex-col gap-1 text-sm">
          {s.checks.map((c) => (
            <li key={c.name} className={c.ok ? '' : 'text-warning'}>
              {c.ok ? '✓' : '⚠'} {c.name} <span className="text-muted">({c.detail})</span>
            </li>
          ))}
        </ul>
        {failed.length > 0 && (
          <p className="mt-2 text-xs text-muted">
            A ⚠ on a paper usually means the reading split or merged a question; open the chapter's
            questions below to check before approving.
          </p>
        )}
      </Card>

      <PapersFound runId={run.id} editable={run.status === 'draft'} onChanged={onChanged} />

      <Card title="What matters most">
        <ul className="list-disc pl-5 text-sm">
          {s.priorities.map((p) => (
            <li key={p} className="mb-1">
              {p}
            </li>
          ))}
          {s.notes.map((n) => (
            <li key={n} className="mb-1 text-muted">
              Board rule: {n}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Paper pattern">
        <Table
          head={['Part', 'Marks each', 'Asked', 'Answer', 'Marks', 'Time each', 'Question types']}
          empty={false}
        >
          {s.parts.map((p) => (
            <tr key={p.part}>
              <Td className="font-semibold">{p.part}</Td>
              <Td>{p.marksEach}</Td>
              <Td>{p.asked}</Td>
              <Td>{p.toAnswer}</Td>
              <Td>
                {p.marksToAnswer} of {p.marksOnPaper}
              </Td>
              <Td>{p.minutesPerQuestion} min</Td>
              <Td className="text-xs">
                {Object.entries(s.typologyByPart[p.part] ?? {})
                  .sort((a, b) => b[1] - a[1])
                  .map(
                    ([t, n]) => `${TYPOLOGY_LABELS[t as keyof typeof TYPOLOGY_LABELS] ?? t} ${n}`,
                  )
                  .join(' · ') || p.typology.join(', ')}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Chapters (click one for its topics and questions)">
        <Table
          head={['Ch', 'Chapter', 'Hours', 'Marks', 'A', 'B', 'C', 'D', 'In board papers']}
          empty={false}
        >
          {s.chapters.map((c) => (
            <Fragment key={c.no}>
              <tr
                className={`cursor-pointer hover:bg-surface-muted ${chapter === c.no ? 'bg-surface-muted' : ''}`}
                onClick={() => setChapter(chapter === c.no ? null : c.no)}
              >
                <Td>{c.no}</Td>
                <Td className="font-medium text-primary underline">{c.title}</Td>
                <Td>{c.hours}</Td>
                <Td className="font-semibold">{c.marks}</Td>
                <Td>{c.partA || '–'}</Td>
                <Td>{c.partB || '–'}</Td>
                <Td>{c.partC || '–'}</Td>
                <Td>{c.partD || '–'}</Td>
                <Td>{c.examAppearances} questions</Td>
              </tr>
              {chapter === c.no && (
                <tr>
                  <td colSpan={9} className="bg-surface-muted p-3">
                    <ChapterDetail runId={run.id} chapter={c} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </Table>
      </Card>

      {s.markSplits.length > 0 && (
        <Card title="How marks are given (from the schemes of evaluation)">
          <Table head={['Part', 'Marks allotment', 'Questions']} empty={false}>
            {s.markSplits.slice(0, 24).map((m) => (
              <tr key={`${m.part}${m.split}`}>
                <Td>{m.part}</Td>
                <Td>{m.split}</Td>
                <Td>{m.count}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {s.answerConventions.length > 0 && (
        <Card title="How full-marks answers are presented (from the centum scripts)">
          <ul className="flex flex-col gap-2 text-sm">
            {s.answerConventions.map((c, i) => (
              <li key={i}>
                <Badge>{c.format.replace(/_/g, ' ')}</Badge> {c.rule}
                {c.example && <div className="mt-1 text-xs text-muted">e.g. {c.example}</div>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {Object.keys(s.difficulty).length > 0 && (
        <Card title="Question bank difficulty labels">
          <p className="text-sm">
            {Object.entries(s.difficulty)
              .map(([d, n]) => `${d} ${n}`)
              .join(' · ')}
          </p>
        </Card>
      )}

      <Card title="Sources">
        <ul className="text-sm">
          {s.sources.map((d) => (
            <li key={d.bookId}>
              {d.title} <span className="text-muted">({d.category.replace(/_/g, ' ')})</span>
            </li>
          ))}
        </ul>
      </Card>

      {run.status === 'draft' && (
        <Card title="Approve">
          <p className="mb-3 text-sm">
            Approving makes this the strategy the app uses for this subject (a previously approved
            version is superseded). Check the ⚠ items and a few chapters first.
          </p>
          <Field label="Review note (optional)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button className="mt-3" disabled={approve.isPending} onClick={() => approve.mutate()}>
            Approve version {run.version}
          </Button>
          <ErrorText error={approve.error ? errorMessage(approve.error) : null} />
        </Card>
      )}
      {run.status === 'approved' && run.reviewNote && (
        <p className="text-sm text-muted">Review note: {run.reviewNote}</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-muted p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}

function ChapterDetail({
  runId,
  chapter,
}: {
  runId: string;
  chapter: ExamStrategy['chapters'][number];
}) {
  const [topic, setTopic] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const items = useQuery({
    queryKey: ['strategy', 'items', runId, chapter.no, topic, source],
    queryFn: () =>
      api<Item[]>(
        `/admin/strategy/${runId}/items?chapter=${chapter.no}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}${source ? `&source=${source}` : ''}`,
      ),
  });
  return (
    <div className="flex flex-col gap-4 text-sm">
      {chapter.problemSpecs.length > 0 && (
        <div>
          <h4 className="mb-1 font-semibold">Allowed problem types (board rules)</h4>
          <ul className="list-disc pl-5">
            {chapter.problemSpecs.map((p) =>
              p.allowed.map((a) => (
                <li key={`${p.part}${a}`}>
                  <Badge>Part {p.part}</Badge> {a}
                </li>
              )),
            )}
          </ul>
        </div>
      )}
      <div>
        <h4 className="mb-1 font-semibold">Topics, most asked first</h4>
        <Table
          head={['Topic', 'Board papers', 'Model papers', 'Bank', 'Parts', 'Marks']}
          empty={chapter.topics.length === 0}
        >
          {chapter.topics.map((t: TopicStat) => (
            <tr
              key={t.name}
              className={`cursor-pointer ${topic === t.name ? 'bg-surface' : ''}`}
              onClick={() => setTopic(topic === t.name ? null : t.name)}
            >
              <Td className="text-primary underline">{t.name}</Td>
              <Td>
                {t.examPapers}
                {t.examYears.length ? ` (${t.examYears.join(', ')})` : ''}
              </Td>
              <Td>{t.modelPapers}</Td>
              <Td>{t.bankItems}</Td>
              <Td>{t.parts.join(', ')}</Td>
              <Td>{t.marks.join(', ')}</Td>
            </tr>
          ))}
        </Table>
      </div>
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h4 className="font-semibold">
            Questions{topic ? `: ${topic}` : ''} ({items.data?.length ?? '…'})
          </h4>
          <Select
            aria-label="Source"
            className="min-h-9 w-auto"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">All sources</option>
            {Object.entries(SOURCE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
        <Table
          head={['Source', 'Q', 'Part / marks', 'Type', 'Question', 'Marking (scheme)']}
          empty={items.data?.length === 0}
        >
          {items.data?.map((i) => (
            <tr key={i.id}>
              <Td className="text-xs">
                {SOURCE_LABEL[i.source]}
                {i.paperLabel ? ` · ${i.paperLabel}` : ''}
                <div className="text-muted">
                  p. {i.page ?? '?'}
                  {i.difficulty ? ` · ${i.difficulty}` : ''}
                </div>
              </Td>
              <Td>{i.qno}</Td>
              <Td>
                {i.part ?? '–'} / {i.marks ?? '–'}
              </Td>
              <Td className="text-xs">{TYPOLOGY_LABELS[i.typology] ?? i.typology}</Td>
              <Td className="max-w-md text-xs">
                <div className="font-medium">{i.topic}</div>
                {i.text}
              </Td>
              <Td className="max-w-xs text-xs">
                {i.markSplit && <div className="font-medium">{i.markSplit}</div>}
                {i.answer}
              </Td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}

interface PaperRow {
  bookId: string;
  bookTitle: string;
  category: string | null;
  source: string;
  paperLabel: string | null;
  examYear: number | null;
  fromPage: number;
  toPage: number;
  questions: number;
  parts: string | null;
}

/**
 * Which papers the compile found, by document and page range. A wrong type or boundary (e.g. a
 * practice paper read as a board exam) is corrected here for free, then the draft is reassembled.
 */
function PapersFound({
  runId,
  editable,
  onChanged,
}: {
  runId: string;
  editable: boolean;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const papers = useQuery({
    queryKey: ['strategy', 'papers', runId],
    queryFn: () => api<PaperRow[]>(`/admin/strategy/${runId}/papers`),
  });
  const docs = [...new Map((papers.data ?? []).map((p) => [p.bookId, p.bookTitle])).entries()];
  const [form, setForm] = useState({
    bookId: '',
    fromPage: '',
    toPage: '',
    source: 'practice_paper',
    paperLabel: '',
    examYear: '',
  });
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['strategy'] });
    onChanged();
  };
  const relabel = useMutation({
    mutationFn: () =>
      api<{ questions: number }>(`/admin/strategy/${runId}/relabel`, {
        method: 'POST',
        body: {
          bookId: form.bookId,
          fromPage: Number(form.fromPage),
          toPage: Number(form.toPage),
          source: form.source,
          paperLabel: form.paperLabel || undefined,
          examYear: form.examYear ? Number(form.examYear) : undefined,
        },
      }),
    onSuccess: (r) => {
      setMsg(`${r.questions} questions updated. Press Reassemble when your corrections are done.`);
      void qc.invalidateQueries({ queryKey: ['strategy', 'papers', runId] });
    },
  });
  const reassemble = useMutation({
    mutationFn: () => api(`/admin/strategy/${runId}/reassemble`, { method: 'POST', body: {} }),
    onSuccess: () => {
      setMsg('Reassembled: the numbers above now use the corrected papers.');
      refresh();
    },
  });

  return (
    <Card title="Papers found">
      <p className="mb-3 text-sm text-muted">
        Frequency (“asked in N board papers”) counts only real board exams. Check that each paper
        has the right type and pages; documents count pages of the stored copy (as on the document's
        review page).
      </p>
      <Table
        head={['Document', 'Paper', 'Type', 'Pages', 'Questions', 'Parts']}
        empty={papers.data?.length === 0}
      >
        {papers.data?.map((p) => (
          <tr key={`${p.bookId}${p.source}${p.paperLabel}`}>
            <Td className="text-xs">{p.bookTitle}</Td>
            <Td>{p.paperLabel ?? (p.source === 'bank' ? 'chapter-wise questions' : '–')}</Td>
            <Td>
              <Badge tone={p.source === 'board_exam' ? 'good' : undefined}>
                {SOURCE_LABEL[p.source] ?? p.source}
                {p.examYear ? ` ${p.examYear}` : ''}
              </Badge>
            </Td>
            <Td>
              {p.fromPage}–{p.toPage}
            </Td>
            <Td>{p.questions}</Td>
            <Td>{p.parts}</Td>
          </tr>
        ))}
      </Table>
      {editable && (
        <form
          className="mt-4 grid gap-2 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            relabel.mutate();
          }}
        >
          <Field label="Document">
            <Select
              required
              value={form.bookId}
              onChange={(e) => setForm({ ...form, bookId: e.target.value })}
            >
              <option value="">Choose…</option>
              {docs.map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From page">
            <Input
              required
              inputMode="numeric"
              value={form.fromPage}
              onChange={(e) => setForm({ ...form, fromPage: e.target.value })}
            />
          </Field>
          <Field label="To page">
            <Input
              required
              inputMode="numeric"
              value={form.toPage}
              onChange={(e) => setForm({ ...form, toPage: e.target.value })}
            />
          </Field>
          <Field label="These pages are">
            <Select
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
            >
              {Object.entries(SOURCE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v === 'Question bank' ? 'Chapter-wise questions (bank)' : v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Paper name">
            <Input
              placeholder="X1-2025"
              disabled={form.source === 'bank'}
              value={form.paperLabel}
              onChange={(e) => setForm({ ...form, paperLabel: e.target.value })}
            />
          </Field>
          <Field label="Exam year (board exams)">
            <Input
              placeholder="2025"
              inputMode="numeric"
              disabled={form.source !== 'board_exam'}
              value={form.examYear}
              onChange={(e) => setForm({ ...form, examYear: e.target.value })}
            />
          </Field>
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            <Button type="submit" variant="secondary" disabled={relabel.isPending}>
              Apply correction
            </Button>
            <Button
              type="button"
              disabled={reassemble.isPending}
              onClick={() => reassemble.mutate()}
            >
              Reassemble the strategy
            </Button>
          </div>
        </form>
      )}
      {msg && <p className="mt-2 text-sm">{msg}</p>}
      <ErrorText
        error={
          relabel.error
            ? errorMessage(relabel.error)
            : reassemble.error
              ? errorMessage(reassemble.error)
              : papers.error
                ? errorMessage(papers.error)
                : null
        }
      />
    </Card>
  );
}
