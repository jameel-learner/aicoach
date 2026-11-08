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
            models for voice input). Quality scores per model arrive with the evaluation suite in
            Phase 2.
          </p>
        </Card>
      </div>
    </>
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
