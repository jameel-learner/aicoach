import {
  RUBRIC,
  RUBRIC_LABELS,
  type AssetCheck,
  type AssetSource,
  type Critique,
} from '@aicoach/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  AssetBody,
  STATUS,
  type AssetKind,
  type AssetStatus,
  type Target,
} from '../components/material';
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
} from '../components/ui';
import { api, errorMessage } from '../lib/api';

/**
 * Teacher: review generated learning material for the subjects you teach (architecture §7
 * Phase 3). Give a rubric score 1–5 and a comment; the Admin sees them and decides what to approve.
 */

interface Offering {
  id: string;
  board: string;
  level: string;
  subject: string;
  chapters: { no: number; title: string }[];
}
interface Row {
  id: string;
  kind: AssetKind;
  chapter: number;
  topic: string;
  marks: number;
  version: number;
  status: AssetStatus;
  checks: AssetCheck[];
  teacherReviews: { count: number; avg: number } | null;
  myScore: number | null;
}
interface Detail extends Omit<Row, 'teacherReviews' | 'myScore'> {
  content: unknown;
  sources: AssetSource[];
  critique: Critique | null;
  target: Target;
  myReview: { score: number; comment: string | null } | null;
  teacherReviews: number;
}

const KINDS: { id: AssetKind; label: string }[] = [
  { id: 'note', label: 'Notes' },
  { id: 'cards', label: 'Cards & memory maps' },
  { id: 'questions', label: 'Question bank' },
  { id: 'graph', label: 'Concept graph' },
];

export function TeacherMaterialPage() {
  const offerings = useQuery({
    queryKey: ['review', 'offerings'],
    queryFn: () => api<Offering[]>('/review/offerings'),
  });
  const [offeringId, setOfferingId] = useState('');
  const [kind, setKind] = useState<AssetKind>('note');
  const [chapter, setChapter] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (!offeringId && offerings.data?.[0]) setOfferingId(offerings.data[0].id);
  }, [offerings.data, offeringId]);
  const offering = offerings.data?.find((o) => o.id === offeringId);
  const list = useQuery({
    queryKey: ['review', 'assets', offeringId, kind, chapter],
    queryFn: () =>
      api<Row[]>(
        `/review/assets?offeringId=${offeringId}&kind=${kind}${chapter && kind !== 'graph' ? `&chapter=${chapter}` : ''}`,
      ),
    enabled: !!offeringId,
  });

  return (
    <>
      <PageHeader
        title="Review learning material"
        subtitle="Notes, cards, question sets and the concept graph generated for the subjects you teach. Score each one against the rubric (1–5) and say what to improve; the Admin uses your reviews to approve what students see."
      />
      {offerings.data?.length === 0 && (
        <Card>
          <p className="text-sm">
            Nothing to review yet: there is no approved exam strategy for a subject you teach.
          </p>
        </Card>
      )}
      <ErrorText error={offerings.error ? errorMessage(offerings.error) : null} />
      {offering && (
        <div className="grid gap-6 xl:grid-cols-[1fr_2fr]">
          <Card
            title="Material"
            actions={
              offerings.data!.length > 1 ? (
                <Select
                  aria-label="Subject"
                  className="min-h-9 w-auto"
                  value={offeringId}
                  onChange={(e) => {
                    setOfferingId(e.target.value);
                    setOpenId(null);
                  }}
                >
                  {offerings.data!.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.board} · {o.level} · {o.subject}
                    </option>
                  ))}
                </Select>
              ) : undefined
            }
          >
            <div className="mb-3 flex flex-wrap gap-2">
              {KINDS.map((k) => (
                <Button
                  key={k.id}
                  variant={kind === k.id ? 'primary' : 'secondary'}
                  className="min-h-9 px-3 text-sm"
                  onClick={() => {
                    setKind(k.id);
                    setOpenId(null);
                  }}
                >
                  {k.label}
                </Button>
              ))}
            </div>
            {kind !== 'graph' && (
              <Select
                aria-label="Chapter"
                className="mb-3"
                value={chapter ?? ''}
                onChange={(e) => setChapter(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">All chapters</option>
                {offering.chapters.map((c) => (
                  <option key={c.no} value={c.no}>
                    {c.no}. {c.title}
                  </option>
                ))}
              </Select>
            )}
            <Table
              head={[
                'Ch',
                kind === 'note' ? 'Topic' : 'Chapter',
                'Marks',
                'Status',
                'Yours',
                'All',
              ]}
              empty={list.data?.length === 0}
            >
              {list.data?.map((r) => (
                <tr
                  key={r.id}
                  className={`cursor-pointer hover:bg-surface-muted ${openId === r.id ? 'bg-surface-muted' : ''}`}
                  onClick={() => setOpenId(r.id)}
                >
                  <Td>{r.chapter || '–'}</Td>
                  <Td className="font-medium text-primary underline">{r.topic}</Td>
                  <Td>{r.marks || '–'}</Td>
                  <Td>
                    <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                  </Td>
                  <Td>{r.myScore ?? '–'}</Td>
                  <Td>
                    {r.teacherReviews
                      ? `${r.teacherReviews.avg.toFixed(1)} (${r.teacherReviews.count})`
                      : '–'}
                  </Td>
                </tr>
              ))}
            </Table>
            <ErrorText error={list.error ? errorMessage(list.error) : null} />
          </Card>
          <div className="flex flex-col gap-6">
            {openId && <ReviewView key={openId} id={openId} />}
          </div>
        </div>
      )}
    </>
  );
}

function ReviewView({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['review', 'asset', id],
    queryFn: () => api<Detail>(`/review/assets/${id}`),
  });
  const [score, setScore] = useState('4');
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (q.data?.myReview) {
      setScore(String(q.data.myReview.score));
      setComment(q.data.myReview.comment ?? '');
    }
  }, [q.data?.myReview]);
  const save = useMutation({
    mutationFn: () =>
      api(`/review/assets/${id}`, {
        method: 'PUT',
        body: { score: Number(score), comment: comment || undefined },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['review'] }),
  });
  if (q.error) return <ErrorText error={errorMessage(q.error)} />;
  if (!q.data) return <p className="text-muted">Loading…</p>;
  const a = q.data;
  const title =
    (a.content as { title?: string }).title ??
    (a.kind === 'graph' ? `Concept graph: ${a.topic}` : `Chapter ${a.chapter}: ${a.topic}`);
  return (
    <>
      <Card title="Your review">
        <p className="mb-3 text-sm text-muted">
          Rubric: {RUBRIC.map((k) => RUBRIC_LABELS[k]).join(' · ')}. 5 = ready for students as it
          is; 4 = small fixes; 3 or less = needs rework (say what).
        </p>
        <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
          <Field label="Score (1–5)">
            <Select value={score} onChange={(e) => setScore(e.target.value)}>
              {[5, 4, 3, 2, 1].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Comment (what to improve)">
            <Input value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
        </div>
        <Button className="mt-3" disabled={save.isPending} onClick={() => save.mutate()}>
          {a.myReview ? 'Update my review' : 'Save my review'}
        </Button>
        {save.isSuccess && <p className="mt-2 text-sm text-muted">Saved.</p>}
        <ErrorText error={save.error ? errorMessage(save.error) : null} />
      </Card>
      <Card
        title={`${title} · version ${a.version}`}
        actions={<Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>}
      >
        <AssetBody kind={a.kind} content={a.content} sources={a.sources} target={a.target} />
        {a.sources.length > 0 && (
          <p className="mt-3 text-xs text-muted">
            Sources: {a.sources.map((s) => `p. ${s.page}`).join(' · ')} ·{' '}
            {a.sources[0]?.bookTitle ?? ''}
          </p>
        )}
      </Card>
      <Card title="Automatic checks">
        <ul className="flex flex-col gap-1 text-sm">
          {a.checks.map((c) => (
            <li key={c.name} className={c.ok ? '' : 'text-warning'}>
              {c.ok ? '✓' : '⚠'} {c.name} <span className="text-muted">({c.detail})</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
