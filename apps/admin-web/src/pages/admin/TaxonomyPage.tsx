import { SUBJECT_STREAMS } from '@aicoach/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useOfferings } from '../../lib/queries';

interface Board {
  id: string;
  code: string;
  name: string;
}
interface Level {
  id: string;
  boardId: string;
  code: string;
  name: string;
  sortOrder: number;
}
interface Subject {
  id: string;
  code: string;
  name: string;
  stream: string;
}

export function TaxonomyPage() {
  const qc = useQueryClient();
  const boards = useQuery({
    queryKey: ['admin', 'boards'],
    queryFn: () => api<Board[]>('/admin/boards'),
  });
  const levels = useQuery({
    queryKey: ['admin', 'levels'],
    queryFn: () => api<Level[]>('/admin/levels'),
  });
  const subjects = useQuery({
    queryKey: ['admin', 'subjects'],
    queryFn: () => api<Subject[]>('/admin/subjects'),
  });
  const offerings = useOfferings();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin'] });
    void qc.invalidateQueries({ queryKey: ['offerings'] });
  };

  const [board, setBoard] = useState({ code: '', name: '' });
  const [level, setLevel] = useState({ boardId: '', code: '', name: '', sortOrder: 0 });
  const [subject, setSubject] = useState({ code: '', name: '', stream: 'commerce' });
  const [offering, setOffering] = useState({ boardId: '', levelId: '', subjectId: '' });

  const addBoard = useMutation({
    mutationFn: () => api('/admin/boards', { method: 'POST', body: board }),
    onSuccess: () => {
      setBoard({ code: '', name: '' });
      invalidate();
    },
  });
  const addLevel = useMutation({
    mutationFn: () => api('/admin/levels', { method: 'POST', body: level }),
    onSuccess: () => {
      setLevel({ ...level, code: '', name: '' });
      invalidate();
    },
  });
  const addSubject = useMutation({
    mutationFn: () => api('/admin/subjects', { method: 'POST', body: subject }),
    onSuccess: () => {
      setSubject({ code: '', name: '', stream: 'commerce' });
      invalidate();
    },
  });
  const addOffering = useMutation({
    mutationFn: () => api('/admin/offerings', { method: 'POST', body: offering }),
    onSuccess: invalidate,
  });

  const boardName = (id: string) => boards.data?.find((b) => b.id === id)?.code ?? '?';

  return (
    <>
      <PageHeader
        title="Boards & subjects"
        subtitle="Exam boards, classes/levels, subjects, and which subjects each board offers at each level"
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Exam boards">
          <Table head={['Code', 'Name']} empty={boards.data?.length === 0}>
            {boards.data?.map((b) => (
              <tr key={b.id}>
                <Td className="font-medium">{b.code}</Td>
                <Td>{b.name}</Td>
              </tr>
            ))}
          </Table>
          <form
            className="mt-4 grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              addBoard.mutate();
            }}
          >
            <Field label="Code">
              <Input
                required
                placeholder="CBSE"
                value={board.code}
                onChange={(e) => setBoard({ ...board, code: e.target.value })}
              />
            </Field>
            <Field label="Name">
              <Input
                required
                value={board.name}
                onChange={(e) => setBoard({ ...board, name: e.target.value })}
              />
            </Field>
            <Button type="submit" disabled={addBoard.isPending}>
              Add
            </Button>
          </form>
          <ErrorText error={addBoard.error ? errorMessage(addBoard.error) : null} />
        </Card>

        <Card title="Classes / levels">
          <Table head={['Board', 'Code', 'Name']} empty={levels.data?.length === 0}>
            {levels.data?.map((l) => (
              <tr key={l.id}>
                <Td>{boardName(l.boardId)}</Td>
                <Td className="font-medium">{l.code}</Td>
                <Td>{l.name}</Td>
              </tr>
            ))}
          </Table>
          <form
            className="mt-4 grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              addLevel.mutate();
            }}
          >
            <Field label="Board">
              <Select
                required
                value={level.boardId}
                onChange={(e) => setLevel({ ...level, boardId: e.target.value })}
              >
                <option value="">Choose…</option>
                {boards.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Code">
              <Input
                required
                placeholder="2PUC"
                value={level.code}
                onChange={(e) => setLevel({ ...level, code: e.target.value })}
              />
            </Field>
            <Field label="Name">
              <Input
                required
                placeholder="2nd PUC"
                value={level.name}
                onChange={(e) => setLevel({ ...level, name: e.target.value })}
              />
            </Field>
            <Field label="Sort order">
              <Input
                type="number"
                min={0}
                value={level.sortOrder}
                onChange={(e) => setLevel({ ...level, sortOrder: Number(e.target.value) })}
              />
            </Field>
            <Button type="submit" disabled={addLevel.isPending} className="sm:col-span-2">
              Add level
            </Button>
          </form>
          <ErrorText error={addLevel.error ? errorMessage(addLevel.error) : null} />
        </Card>

        <Card title="Subjects">
          <Table head={['Code', 'Name', 'Stream']} empty={subjects.data?.length === 0}>
            {subjects.data?.map((s) => (
              <tr key={s.id}>
                <Td className="font-medium">{s.code}</Td>
                <Td>{s.name}</Td>
                <Td>{s.stream}</Td>
              </tr>
            ))}
          </Table>
          <form
            className="mt-4 grid gap-3 sm:grid-cols-3 sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              addSubject.mutate();
            }}
          >
            <Field label="Code">
              <Input
                required
                value={subject.code}
                onChange={(e) => setSubject({ ...subject, code: e.target.value })}
              />
            </Field>
            <Field label="Name">
              <Input
                required
                value={subject.name}
                onChange={(e) => setSubject({ ...subject, name: e.target.value })}
              />
            </Field>
            <Field label="Stream">
              <Select
                value={subject.stream}
                onChange={(e) => setSubject({ ...subject, stream: e.target.value })}
              >
                {SUBJECT_STREAMS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" disabled={addSubject.isPending} className="sm:col-span-3">
              Add subject
            </Button>
          </form>
          <ErrorText error={addSubject.error ? errorMessage(addSubject.error) : null} />
        </Card>

        <Card title="Subject offerings">
          <Table head={['Board', 'Level', 'Subject']} empty={offerings.data?.length === 0}>
            {offerings.data?.map((o) => (
              <tr key={o.id}>
                <Td>{o.board.code}</Td>
                <Td>{o.level.name}</Td>
                <Td className="font-medium">{o.subject.name}</Td>
              </tr>
            ))}
          </Table>
          <form
            className="mt-4 grid gap-3 sm:grid-cols-3 sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              addOffering.mutate();
            }}
          >
            <Field label="Board">
              <Select
                required
                value={offering.boardId}
                onChange={(e) => setOffering({ ...offering, boardId: e.target.value, levelId: '' })}
              >
                <option value="">Choose…</option>
                {boards.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Level">
              <Select
                required
                value={offering.levelId}
                onChange={(e) => setOffering({ ...offering, levelId: e.target.value })}
              >
                <option value="">Choose…</option>
                {levels.data
                  ?.filter((l) => l.boardId === offering.boardId)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Subject">
              <Select
                required
                value={offering.subjectId}
                onChange={(e) => setOffering({ ...offering, subjectId: e.target.value })}
              >
                <option value="">Choose…</option>
                {subjects.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" disabled={addOffering.isPending} className="sm:col-span-3">
              Add offering
            </Button>
          </form>
          <ErrorText error={addOffering.error ? errorMessage(addOffering.error) : null} />
        </Card>
      </div>
    </>
  );
}
