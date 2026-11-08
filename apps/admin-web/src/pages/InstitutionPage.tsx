import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import {
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
import { useOfferings } from '../lib/queries';

interface ClassRow {
  id: string;
  name: string;
  academicYear: string;
  joinCode: string;
  offering: { id: string; board: string; level: string; subject: string };
  classTeacher: { id: string; name: string; email: string } | null;
  studentCount: number;
}

function currentAcademicYear() {
  const d = new Date();
  const start = d.getMonth() >= 5 ? d.getFullYear() : d.getFullYear() - 1; // Indian academic year starts ~June
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Institution POC area: classes (with class teacher, join code, student count) and teachers. */
export function InstitutionPage() {
  const { institutionId } = useParams({ strict: false }) as { institutionId: string };
  const qc = useQueryClient();
  const inst = useQuery({
    queryKey: ['inst', institutionId],
    queryFn: () => api<{ name: string; city: string | null }>(`/institutions/${institutionId}`),
  });
  const classes = useQuery({
    queryKey: ['inst', institutionId, 'classes'],
    queryFn: () => api<ClassRow[]>(`/institutions/${institutionId}/classes`),
  });
  const teachers = useQuery({
    queryKey: ['inst', institutionId, 'teachers'],
    queryFn: () =>
      api<{ id: string; name: string; email: string }[]>(`/institutions/${institutionId}/teachers`),
  });
  const offerings = useOfferings();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['inst', institutionId] });

  const [form, setForm] = useState({
    offeringId: '',
    name: '',
    academicYear: currentAcademicYear(),
  });
  const create = useMutation({
    mutationFn: () => api(`/institutions/${institutionId}/classes`, { method: 'POST', body: form }),
    onSuccess: () => {
      setForm({ ...form, name: '' });
      refresh();
    },
  });
  const [teacherEmail, setTeacherEmail] = useState<Record<string, string>>({});
  const assign = useMutation({
    mutationFn: (classId: string) =>
      api(`/institutions/${institutionId}/classes/${classId}/teacher`, {
        method: 'PUT',
        body: { email: teacherEmail[classId] ?? '' },
      }),
    onSuccess: refresh,
  });

  return (
    <>
      <PageHeader
        title={inst.data?.name ?? 'Institution'}
        subtitle="Classes, class teachers and join codes"
      />
      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card title="Classes">
          <Table
            head={['Class', 'Subject', 'Join code', 'Students', 'Class teacher']}
            empty={classes.data?.length === 0}
          >
            {classes.data?.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium">
                  <Link
                    to="/classes/$classId"
                    params={{ classId: c.id }}
                    className="text-primary underline"
                  >
                    {c.name}
                  </Link>
                  <div className="text-xs text-muted">{c.academicYear}</div>
                </Td>
                <Td>
                  {c.offering.board} · {c.offering.level} · {c.offering.subject}
                </Td>
                <Td>
                  <code className="rounded bg-surface-muted px-2 py-1 font-mono">{c.joinCode}</code>
                </Td>
                <Td>{c.studentCount}</Td>
                <Td>
                  {c.classTeacher ? (
                    <span>
                      {c.classTeacher.name}
                      <div className="text-xs text-muted">{c.classTeacher.email}</div>
                    </span>
                  ) : (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        assign.mutate(c.id);
                      }}
                    >
                      <Input
                        type="email"
                        required
                        placeholder="teacher@email"
                        className="min-h-9 w-44"
                        value={teacherEmail[c.id] ?? ''}
                        onChange={(e) =>
                          setTeacherEmail({ ...teacherEmail, [c.id]: e.target.value })
                        }
                        aria-label={`Class teacher email for ${c.name}`}
                      />
                      <Button
                        type="submit"
                        className="min-h-9 px-3 text-sm"
                        disabled={assign.isPending}
                      >
                        Assign
                      </Button>
                    </form>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          <ErrorText
            error={
              classes.error
                ? errorMessage(classes.error)
                : assign.error
                  ? errorMessage(assign.error)
                  : null
            }
          />
          <p className="mt-3 text-sm text-muted">
            Students join a class in the mobile app with its join code.
          </p>
        </Card>

        <div className="flex flex-col gap-6">
          <Card title="Add class">
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <Field label="Subject">
                <Select
                  required
                  value={form.offeringId}
                  onChange={(e) => setForm({ ...form, offeringId: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {offerings.data?.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.board.code} · {o.level.name} · {o.subject.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Class name">
                <Input
                  required
                  placeholder="2nd PUC Commerce A"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </Field>
              <Field label="Academic year">
                <Input
                  required
                  pattern="\d{4}-\d{2}"
                  value={form.academicYear}
                  onChange={(e) => setForm({ ...form, academicYear: e.target.value })}
                />
              </Field>
              <ErrorText error={create.error ? errorMessage(create.error) : null} />
              <Button type="submit" disabled={create.isPending}>
                Create class
              </Button>
            </form>
          </Card>
          <Card title="Teachers">
            {teachers.data?.length === 0 && (
              <p className="text-muted">No teachers yet. Assign a class teacher to a class.</p>
            )}
            <ul className="flex flex-col gap-2">
              {teachers.data?.map((t) => (
                <li key={t.id}>
                  {t.name} <span className="text-muted">({t.email})</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
