import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Badge, Card, ErrorText, PageHeader, Table, Td } from '../components/ui';
import { api, errorMessage } from '../lib/api';

interface TeacherClass {
  id: string;
  name: string;
  academicYear: string;
  joinCode: string;
  isClassTeacher: boolean;
  institution: { id: string; name: string };
  offering: { board: string; level: string; subject: string };
  studentCount: number;
}

export function TeacherClassesPage() {
  const classes = useQuery({
    queryKey: ['teacher', 'classes'],
    queryFn: () => api<TeacherClass[]>('/teacher/classes'),
  });
  return (
    <>
      <PageHeader title="My classes" subtitle="Classes you teach and their students" />
      {classes.data?.length === 0 && (
        <Card>
          <p className="text-muted">
            You haven't been added to a class yet. Your institution's POC assigns class teachers.
          </p>
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {classes.data?.map((c) => (
          <Link
            key={c.id}
            to="/classes/$classId"
            params={{ classId: c.id }}
            className="rounded-2xl border border-border bg-surface p-5 hover:bg-surface-muted"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-lg font-semibold">{c.name}</p>
              {c.isClassTeacher && <Badge tone="good">Class teacher</Badge>}
            </div>
            <p className="text-muted">{c.institution.name}</p>
            <p className="text-muted">
              {c.offering.board} · {c.offering.level} · {c.offering.subject}
            </p>
            <p className="mt-3">
              {c.studentCount} students · join code <code className="font-mono">{c.joinCode}</code>
            </p>
          </Link>
        ))}
      </div>
      <ErrorText error={classes.error ? errorMessage(classes.error) : null} />
    </>
  );
}

export function ClassStudentsPage() {
  const { classId } = useParams({ strict: false }) as { classId: string };
  const students = useQuery({
    queryKey: ['class', classId, 'students'],
    queryFn: () =>
      api<{ id: string; name: string; email: string; enrolledAt: string }[]>(
        `/teacher/classes/${classId}/students`,
      ),
  });
  return (
    <>
      <PageHeader title="Students" subtitle="Students enrolled in this class" />
      <Card>
        <Table head={['Name', 'Email', 'Joined']} empty={students.data?.length === 0}>
          {students.data?.map((s) => (
            <tr key={s.id}>
              <Td className="font-medium">{s.name}</Td>
              <Td>{s.email}</Td>
              <Td>{new Date(s.enrolledAt).toLocaleDateString()}</Td>
            </tr>
          ))}
        </Table>
        <ErrorText error={students.error ? errorMessage(students.error) : null} />
      </Card>
    </>
  );
}
