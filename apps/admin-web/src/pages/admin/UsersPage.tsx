import { formatInr, ROLE_LABELS, ROLES, type EnrolmentView, type Role } from '@aicoach/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
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
import { useMe } from '../../lib/queries';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  emailVerified: boolean;
  createdAt: string;
}

export function UsersPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  if (role) params.set('role', role);
  const users = useQuery({
    queryKey: ['admin', 'users', q, role],
    queryFn: () => api<UserRow[]>(`/admin/users?${params}`),
  });
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      api(`/admin/users/${id}/role`, { method: 'PATCH', body: { role } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Search accounts, change roles, and see or remove a learner's classes and subjects. Changes are audited."
      />
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-[2fr_1fr]">
          <Input
            placeholder="Search name or email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search"
          />
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            aria-label="Filter by role"
          >
            <option value="">All roles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </div>
        <Table
          head={['Name', 'Email', 'Verified', 'Role', 'Classes & subjects']}
          empty={users.data?.length === 0}
        >
          {users.data?.map((u) => (
            <Fragment key={u.id}>
              <tr>
                <Td className="font-medium">{u.name}</Td>
                <Td>{u.email}</Td>
                <Td>
                  {u.emailVerified ? <Badge tone="good">yes</Badge> : <Badge tone="warn">no</Badge>}
                </Td>
                <Td>
                  <Select
                    aria-label={`Role for ${u.email}`}
                    value={u.role}
                    disabled={u.id === me?.user.id || changeRole.isPending}
                    onChange={(e) => changeRole.mutate({ id: u.id, role: e.target.value as Role })}
                    className="min-h-9"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </Select>
                </Td>
                <Td>
                  {u.role === 'student' || u.role === 'teacher' ? (
                    <Button
                      variant="secondary"
                      className="min-h-9 px-3 text-sm"
                      aria-expanded={openId === u.id}
                      onClick={() => setOpenId(openId === u.id ? null : u.id)}
                    >
                      {openId === u.id ? 'Hide' : 'Show'}
                    </Button>
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                </Td>
              </tr>
              {openId === u.id && (
                <tr>
                  <td colSpan={5} className="bg-surface-muted px-3 py-3">
                    <UserEnrolments user={u} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </Table>
        <ErrorText
          error={
            users.error
              ? errorMessage(users.error)
              : changeRole.error
                ? errorMessage(changeRole.error)
                : null
          }
        />
      </Card>
    </>
  );
}

/** A learner's classes and self-study subjects, with Remove (decision 9.4-2). */
function UserEnrolments({ user }: { user: UserRow }) {
  const qc = useQueryClient();
  const [done, setDone] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['admin', 'users', user.id, 'enrolments'],
    queryFn: () => api<EnrolmentView[]>(`/admin/users/${user.id}/enrolments`),
  });
  const remove = useMutation({
    mutationFn: (e: EnrolmentView) =>
      api<{ returnedMicro: number }>(`/admin/users/${user.id}/enrolments/${e.id}`, {
        method: 'DELETE',
      }),
    onSuccess: (res, e) => {
      setDone(
        `Removed from ${e.classGroup?.name ?? `${e.offering.subject} (self-study)`}.` +
          (res.returnedMicro > 0
            ? ` ${formatInr(res.returnedMicro)} of unused class credit went back to the class.`
            : ''),
      );
      void qc.invalidateQueries({ queryKey: ['admin', 'users', user.id, 'enrolments'] });
    },
  });
  if (list.isLoading) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <div className="text-sm">
      {list.data?.length === 0 && <p className="text-muted">Not in any class or subject.</p>}
      <ul className="flex flex-col gap-2">
        {list.data?.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="font-medium">
                {e.offering.board} {e.offering.level} {e.offering.subject}
              </span>
              {' · '}
              {e.classGroup
                ? `${e.institution?.name ?? ''} · ${e.classGroup.name}`
                : 'Self-study (no institution)'}
              {e.roleIn === 'teacher' && ' · as teacher'}
            </span>
            <Button
              variant="danger"
              className="min-h-9 px-3 text-sm"
              disabled={remove.isPending}
              onClick={() => {
                const what = e.classGroup
                  ? `the class ${e.classGroup.name}? Their unused credits for this class go back to the class; their own credits stay.`
                  : `self-study ${e.offering.subject}?`;
                if (window.confirm(`Remove ${user.email} from ${what}`)) remove.mutate(e);
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {done && <p className="mt-2 text-text">{done}</p>}
      <ErrorText
        error={
          list.error ? errorMessage(list.error) : remove.error ? errorMessage(remove.error) : null
        }
      />
    </div>
  );
}
