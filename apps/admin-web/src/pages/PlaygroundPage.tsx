import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, ErrorText, Field, PageHeader, Select } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { cr, usd } from '../lib/credits';
import { useMe } from '../lib/queries';

interface Result {
  answer: string;
  taskLabel: string;
  model: string | null;
  rawUsdNano: number | null;
  billedMicro: number;
  cacheHit: boolean;
  tokens: { prompt: number | null; completion: number | null };
  wallet: { id: string; availableMicro: number };
}
interface TeacherClass {
  id: string;
  name: string;
  isClassTeacher: boolean;
}

/** Sends a prompt through the full metered path (registry → OpenRouter → credits). */
export function PlaygroundPage() {
  const { data: me } = useMe();
  const isTeacher = me?.user.role === 'teacher';
  const classes = useQuery({
    queryKey: ['teacher', 'classes'],
    queryFn: () => api<TeacherClass[]>('/teacher/classes'),
    enabled: isTeacher,
  });
  const [prompt, setPrompt] = useState(
    'Explain the difference between a journal and a ledger in two sentences.',
  );
  const [classGroupId, setClassGroupId] = useState('');
  const run = useMutation({
    mutationFn: () =>
      api<Result>('/ai/playground', {
        method: 'POST',
        body: { prompt, classGroupId: classGroupId || undefined },
      }),
  });
  const r = run.data;

  return (
    <>
      <PageHeader
        title="AI playground"
        subtitle={
          isTeacher
            ? 'Try the AI. Paid from the class you pick (then your own balance).'
            : 'Try the AI. Paid at cost from the platform wallet.'
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate();
            }}
          >
            {isTeacher && (
              <Field label="Pay from">
                <Select value={classGroupId} onChange={(e) => setClassGroupId(e.target.value)}>
                  <option value="">My own balance</option>
                  {classes.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} (class balance)
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Prompt">
              <textarea
                className="min-h-32 rounded-lg border border-border bg-surface p-3 text-text"
                maxLength={4000}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </Field>
            <ErrorText error={run.error ? errorMessage(run.error) : null} />
            <Button type="submit" disabled={run.isPending || !prompt.trim()}>
              {run.isPending ? 'Asking…' : 'Send'}
            </Button>
          </form>
        </Card>
        {r && (
          <Card title="Answer">
            <p className="whitespace-pre-wrap">{r.answer}</p>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted">Charged</dt>
              <dd className="font-semibold">
                {cr(r.billedMicro)}
                {r.cacheHit ? ' (cached, free)' : ''}
              </dd>
              {r.rawUsdNano !== null && (
                <>
                  <dt className="text-muted">OpenRouter cost</dt>
                  <dd>{usd(r.rawUsdNano)}</dd>
                </>
              )}
              {r.model && (
                <>
                  <dt className="text-muted">Model</dt>
                  <dd>{r.model}</dd>
                </>
              )}
              <dt className="text-muted">Tokens (in / out)</dt>
              <dd>
                {r.tokens.prompt ?? '—'} / {r.tokens.completion ?? '—'}
              </dd>
              <dt className="text-muted">Wallet available now</dt>
              <dd>{cr(r.wallet.availableMicro)}</dd>
            </dl>
          </Card>
        )}
      </div>
    </>
  );
}
