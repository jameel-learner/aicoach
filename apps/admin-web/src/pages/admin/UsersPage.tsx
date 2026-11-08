import { ROLE_LABELS, ROLES, type Role } from '@aicoach/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Card, ErrorText, Input, PageHeader, Select, Table, Td } from '../../components/ui';
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
        subtitle="Search accounts and change roles. Role changes are audited."
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
        <Table head={['Name', 'Email', 'Verified', 'Role']} empty={users.data?.length === 0}>
          {users.data?.map((u) => (
            <tr key={u.id}>
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
            </tr>
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
