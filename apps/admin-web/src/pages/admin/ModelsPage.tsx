import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Input,
  PageHeader,
  Select,
  Table,
  Td,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { fmtDate } from '../../lib/credits';

interface ModelView {
  id: string;
  name: string;
  contextLength: number | null;
  promptUsdPerM: number;
  completionUsdPerM: number;
  capabilities: string[];
  selectable: boolean;
  available: boolean;
  syncedAt: string | null;
}
interface TaskView {
  task: string;
  label: string;
  needs: string[];
  primaryModel: string;
  fallbackModels: string[];
  isDefault: boolean;
  options: string[];
}
interface ModelsResponse {
  tasks: TaskView[];
  models: ModelView[];
  catalogSize: number;
  lastSyncedAt: string | null;
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

export function ModelsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: () => api<ModelsResponse>('/admin/models'),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin', 'models'] });
  const sync = useMutation({
    mutationFn: () => api<{ count: number }>('/admin/models/sync', { method: 'POST' }),
    onSuccess: refresh,
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: ({
      task,
      primaryModel,
      fallbackModels,
    }: {
      task: string;
      primaryModel: string;
      fallbackModels: string[];
    }) =>
      api(`/admin/models/registry/${task}`, {
        method: 'PUT',
        body: { primaryModel, fallbackModels },
      }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: ({ id, selectable }: { id: string; selectable: boolean }) =>
      api('/admin/models/selectable', { method: 'PUT', body: { id, selectable } }),
    onSuccess: () => {
      setError(null);
      refresh();
      setSearch('');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const [search, setSearch] = useState('');
  const catalog = useQuery({
    queryKey: ['admin', 'catalog', search],
    queryFn: () => api<ModelView[]>(`/admin/models/catalog?q=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 2,
  });

  const data = q.data;
  const needsSync = data && data.catalogSize === 0;

  return (
    <>
      <PageHeader
        title="AI models"
        subtitle="Choose which OpenRouter model serves each feature. Changes apply within about 30 seconds, without a redeploy."
      />
      <Card
        title="Model list"
        actions={
          <Button variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? 'Syncing…' : 'Sync from OpenRouter'}
          </Button>
        }
      >
        {needsSync && (
          <p role="alert" className="mb-3 text-warning">
            Sync once to load models and prices from OpenRouter (it also runs nightly).
          </p>
        )}
        {sync.data && <p className="mb-3 text-accent">Synced {sync.data.count} models.</p>}
        <ErrorText
          error={sync.error ? errorMessage(sync.error) : q.error ? errorMessage(q.error) : null}
        />
        <Table
          head={['Model', 'Input $/M tokens', 'Output $/M tokens', 'Can handle', '']}
          empty={data?.models.length === 0}
        >
          {data?.models.map((m) => (
            <tr key={m.id}>
              <Td className="font-medium">
                {m.id}
                <div className="text-xs text-muted">{m.name}</div>
              </Td>
              <Td>{usd(m.promptUsdPerM)}</Td>
              <Td>{usd(m.completionUsdPerM)}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {m.capabilities.map((c) => (
                    <Badge key={c}>{c}</Badge>
                  ))}
                  {!m.available && <Badge tone="warn">retired</Badge>}
                </div>
              </Td>
              <Td>
                <button
                  className="text-sm font-semibold text-danger underline"
                  onClick={() => toggle.mutate({ id: m.id, selectable: false })}
                >
                  Remove
                </button>
              </Td>
            </tr>
          ))}
        </Table>
        <div className="mt-4 flex flex-col gap-2">
          <Input
            placeholder="Add another model: search OpenRouter (e.g. llama, mistral)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search models"
          />
          {catalog.data
            ?.filter((m) => !m.selectable)
            .slice(0, 8)
            .map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border p-2 text-sm"
              >
                <span>
                  {m.id} · in {usd(m.promptUsdPerM)} / out {usd(m.completionUsdPerM)} per M ·{' '}
                  {m.capabilities.join(', ')}
                </span>
                <Button
                  variant="secondary"
                  className="min-h-9 px-3 text-sm"
                  onClick={() => toggle.mutate({ id: m.id, selectable: true })}
                >
                  Add
                </Button>
              </div>
            ))}
        </div>
        {data?.lastSyncedAt && (
          <p className="mt-3 text-sm text-muted">
            Oldest price data from {fmtDate(data.lastSyncedAt)}.
          </p>
        )}
      </Card>

      <div className="mt-6">
        <Card title="Model per feature">
          <ErrorText error={error} />
          <Table head={['Feature', 'Needs', 'Model', 'Fallback (if the first fails)']}>
            {data?.tasks.map((t) => (
              <TaskRow
                key={t.task}
                t={t}
                onSave={(primaryModel, fallbackModels) =>
                  save.mutate({ task: t.task, primaryModel, fallbackModels })
                }
              />
            ))}
          </Table>
          <p className="mt-3 text-sm text-muted">
            Only models that can handle what a feature needs are offered (e.g. only audio-capable
            models for voice input).
          </p>
        </Card>
      </div>
      <div className="mt-6">
        <EvalScores />
      </div>
      <div className="mt-6">
        <SavedAnswers />
      </div>
    </>
  );
}

interface EvalRun {
  id: string;
  model: string;
  promptVersion: string;
  questions: number;
  citationAccuracy: number;
  correctness: number;
  notes: string | null;
  createdAt: string;
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** Latest eval-harness run per model (evals/run.mjs). Targets: citations ≥ 90%, correctness ≥ 85%. */
function EvalScores() {
  const q = useQuery({
    queryKey: ['admin', 'evals'],
    queryFn: () => api<EvalRun[]>('/admin/evals/runs'),
  });
  return (
    <Card title="Answer quality (golden-set evaluation)">
      <ErrorText error={q.error ? errorMessage(q.error) : null} />
      <Table
        head={['Model', 'Citation accuracy', 'Correctness', 'Questions', 'Prompt', 'Run']}
        empty={q.data?.length === 0}
      >
        {q.data?.map((r) => (
          <tr key={r.id}>
            <Td className="font-medium">{r.model}</Td>
            <Td>
              <Badge tone={r.citationAccuracy >= 0.9 ? 'good' : 'warn'}>
                {pct(r.citationAccuracy)}
              </Badge>
            </Td>
            <Td>
              <Badge tone={r.correctness >= 0.85 ? 'good' : 'warn'}>{pct(r.correctness)}</Badge>
            </Td>
            <Td>{r.questions}</Td>
            <Td>{r.promptVersion}</Td>
            <Td className="whitespace-nowrap">{fmtDate(r.createdAt)}</Td>
          </tr>
        ))}
      </Table>
      <p className="mt-3 text-sm text-muted">
        Run on your PC:{' '}
        <code>node evals/run.mjs --email &lt;admin&gt; --password &lt;password&gt;</code> (add{' '}
        <code>--model &lt;slug&gt;</code> to score another model). Targets: citation accuracy ≥ 90%,
        correctness ≥ 85%.
      </p>
    </Card>
  );
}

function TaskRow({
  t,
  onSave,
}: {
  t: TaskView;
  onSave: (primary: string, fallbacks: string[]) => void;
}) {
  const fallback = t.fallbackModels[0] ?? '';
  return (
    <tr>
      <Td className="font-medium">
        {t.label}
        <div className="text-xs text-muted">
          {t.task}
          {t.isDefault ? ' · default' : ''}
        </div>
      </Td>
      <Td>
        <div className="flex flex-wrap gap-1">
          {t.needs.map((n) => (
            <Badge key={n}>{n}</Badge>
          ))}
        </div>
      </Td>
      <Td>
        <Select
          className="min-h-9"
          value={t.primaryModel}
          onChange={(e) =>
            onSave(e.target.value, fallback && fallback !== e.target.value ? [fallback] : [])
          }
          aria-label={`Model for ${t.label}`}
        >
          {!t.options.includes(t.primaryModel) && (
            <option value={t.primaryModel}>{t.primaryModel}</option>
          )}
          {t.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      </Td>
      <Td>
        <Select
          className="min-h-9"
          value={fallback}
          onChange={(e) => onSave(t.primaryModel, e.target.value ? [e.target.value] : [])}
          aria-label={`Fallback for ${t.label}`}
        >
          <option value="">(none)</option>
          {t.options
            .filter((o) => o !== t.primaryModel)
            .map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
        </Select>
      </Td>
    </tr>
  );
}

interface SavedGenerator {
  generator: string;
  model: string;
  promptVersion: string;
  total: number;
  reusable: number;
  reused: number;
  lastAt: string | null;
  current: boolean;
}

/**
 * Saved answers of "Ask your textbook" per generator (tutor model + prompt version, decision 9.5-3).
 * Only the current generator's answers are reused; Stop reusing retires them (kept, never deleted).
 */
function SavedAnswers() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'saved-answers'],
    queryFn: () => api<{ current: string; generators: SavedGenerator[] }>('/admin/saved-answers'),
  });
  const [done, setDone] = useState<string | null>(null);
  const retire = useMutation({
    mutationFn: (generator: string) =>
      api<{ retired: number }>('/admin/saved-answers/retire', {
        method: 'POST',
        body: { generator },
      }),
    onSuccess: (r) => {
      setDone(`${r.retired} saved answers will no longer be reused.`);
      void qc.invalidateQueries({ queryKey: ['admin', 'saved-answers'] });
    },
  });
  return (
    <Card title="Saved answers (Ask your textbook)">
      <p className="mb-3 text-sm text-muted">
        A question asked again (or a very similar one) gets its saved answer free. Only answers of
        the <strong>current</strong> tutor model and prompt version are reused, so a model switch
        takes effect at once; switching back reuses that model's answers again. Stop reusing keeps
        the answers as history but never serves them again (e.g. after correcting a textbook page).
      </p>
      <ErrorText
        error={q.error ? errorMessage(q.error) : retire.error ? errorMessage(retire.error) : null}
      />
      <Table
        head={['Model', 'Prompt', 'Saved', 'Reusable', 'Times reused', 'Last saved', '']}
        empty={q.data?.generators.length === 0}
      >
        {q.data?.generators.map((g) => (
          <tr key={g.generator}>
            <Td className="font-medium">
              {g.model} {g.current && <Badge tone="good">in use</Badge>}
            </Td>
            <Td>{g.promptVersion}</Td>
            <Td>{g.total}</Td>
            <Td>{g.reusable}</Td>
            <Td>{g.reused}</Td>
            <Td>{g.lastAt ? fmtDate(g.lastAt) : '–'}</Td>
            <Td>
              {g.reusable > 0 && (
                <Button
                  variant="danger"
                  className="min-h-9 px-3 text-sm"
                  disabled={retire.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Stop reusing ${g.reusable} saved answers of ${g.model} (${g.promptVersion})? The next time each question is asked it is answered fresh (charged).`,
                      )
                    )
                      retire.mutate(g.generator);
                  }}
                >
                  Stop reusing
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {done && <p className="mt-2 text-sm">{done}</p>}
    </Card>
  );
}
