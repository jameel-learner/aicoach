import { INSTITUTION_TYPES } from '@aicoach/core';
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
import { api, errorMessage } from '../../lib/api';

interface InstitutionRow {
  id: string;
  name: string;
  type: string;
  city: string | null;
  status: 'active' | 'suspended';
  pocCount: number;
}
interface Poc {
  id: string;
  name: string;
  email: string;
  role: string;
}

export function InstitutionsPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['admin', 'institutions'],
    queryFn: () => api<InstitutionRow[]>('/admin/institutions'),
  });
  const [form, setForm] = useState({ name: '', type: 'college', city: '' });
  const [selected, setSelected] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api('/admin/institutions', {
        method: 'POST',
        body: { ...form, city: form.city || undefined },
      }),
    onSuccess: () => {
      setForm({ name: '', type: 'college', city: '' });
      void qc.invalidateQueries({ queryKey: ['admin', 'institutions'] });
    },
  });

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <>
      <PageHeader
        title="Institutions"
        subtitle="Onboard schools and colleges, and assign their POCs"
      />
      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card title="All institutions">
          <Table
            head={['Name', 'Type', 'City', 'POCs', 'Status', '']}
            empty={list.data?.length === 0}
          >
            {list.data?.map((i) => (
              <tr key={i.id}>
                <Td className="font-medium">{i.name}</Td>
                <Td>{i.type}</Td>
                <Td>{i.city ?? '—'}</Td>
                <Td>{i.pocCount}</Td>
                <Td>
                  <Badge tone={i.status === 'active' ? 'good' : 'warn'}>{i.status}</Badge>
                </Td>
                <Td className="whitespace-nowrap">
                  <button
                    className="font-semibold text-primary underline"
                    onClick={() => setSelected(i.id)}
                  >
                    POCs
                  </button>{' '}
                  ·{' '}
                  <Link
                    to="/institutions/$institutionId"
                    params={{ institutionId: i.id }}
                    className="font-semibold text-primary underline"
                  >
                    Classes
                  </Link>
                </Td>
              </tr>
            ))}
          </Table>
          <ErrorText error={list.error ? errorMessage(list.error) : null} />
        </Card>

        <div className="flex flex-col gap-6">
          <Card title="Add institution">
            <form onSubmit={onCreate} className="flex flex-col gap-3">
              <Field label="Name">
                <Input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </Field>
              <Field label="Type">
                <Select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                >
                  {INSTITUTION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="City">
                <Input
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                />
              </Field>
              <ErrorText error={create.error ? errorMessage(create.error) : null} />
              <Button type="submit" disabled={create.isPending}>
                Add
              </Button>
            </form>
          </Card>
          {selected && <PocPanel institution={list.data?.find((i) => i.id === selected)} />}
        </div>
      </div>
    </>
  );
}

function PocPanel({ institution }: { institution?: InstitutionRow }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const id = institution?.id ?? '';
  const pocs = useQuery({
    queryKey: ['admin', 'pocs', id],
    queryFn: () => api<Poc[]>(`/admin/institutions/${id}/pocs`),
    enabled: !!id,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'pocs', id] });
    void qc.invalidateQueries({ queryKey: ['admin', 'institutions'] });
  };
  const add = useMutation({
    mutationFn: () => api(`/admin/institutions/${id}/pocs`, { method: 'POST', body: { email } }),
    onSuccess: () => {
      setEmail('');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      api(`/admin/institutions/${id}/pocs/${userId}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  if (!institution) return null;

  return (
    <Card title={`POCs: ${institution.name}`}>
      <ul className="mb-4 flex flex-col gap-2">
        {pocs.data?.length === 0 && <li className="text-muted">No POC yet.</li>}
        {pocs.data?.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2">
            <span>
              {p.name} <span className="text-muted">({p.email})</span>
            </span>
            <Button
              variant="danger"
              className="min-h-9 px-3 text-sm"
              onClick={() => remove.mutate(p.id)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
        className="flex flex-col gap-3"
      >
        <Field
          label="Add POC by email"
          hint="The person must have signed up first (as a teacher or other non-student account)."
        >
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <ErrorText
          error={
            add.error ? errorMessage(add.error) : remove.error ? errorMessage(remove.error) : null
          }
        />
        <Button type="submit" disabled={add.isPending}>
          Assign POC
        </Button>
      </form>
    </Card>
  );
}
