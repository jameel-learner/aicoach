import { useQuery } from '@tanstack/react-query';
import { Badge, Card, ErrorText, PageHeader, Table, Td } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';

interface SafetyEvent {
  id: string;
  createdAt: number;
  source: 'session' | 'ask' | 'artefact';
  detector: 'rules' | 'model';
  rule: string;
  notified: 'parent' | 'poc' | 'none' | 'suppressed';
  name: string;
  email: string;
}

const WHERE = { session: 'Study session', ask: 'Ask your textbook', artefact: 'Own card' } as const;
const TOLD = {
  parent: 'Parent emailed',
  poc: 'Institution emailed',
  suppressed: 'Already told in the last 12 hours',
  none: 'Nobody to tell',
} as const;
const RULE: Record<string, string> = {
  self_harm: 'Self-harm wording',
  self_harm_hi: 'Self-harm wording (Hindi)',
  self_harm_kn: 'Self-harm wording (Kannada)',
  hopeless: 'Hopelessness',
  harm_by_others: 'Harm by someone else',
  acute: 'Acute distress',
  guard_self_harm: 'Guard model: self-harm',
};

/**
 * Safety triggers (architecture §6.2, decision 9.6-5): when a learner's message looked like
 * distress, the app stopped, showed the fixed response with the helpline and told an adult.
 * What the learner wrote is not stored.
 */
export function SafetyPage() {
  const q = useQuery({
    queryKey: ['admin', 'safety'],
    queryFn: () => api<{ events: SafetyEvent[] }>('/admin/safety'),
  });
  return (
    <>
      <PageHeader
        title="Safety"
        subtitle="Times a learner's message looked like distress. The app showed the fixed response with the helpline and did not continue with the AI."
      />
      <Card title="Triggers (latest 200)">
        <p className="mb-3 text-sm text-muted">
          What the learner wrote is not kept: only which kind of wording was matched and who was
          told. <strong>Nobody to tell</strong> means there was no confirmed parent contact and no
          institution, or real email is not switched on for this environment: please follow up
          yourself. A parent is not emailed when the wording was about harm by someone else; the
          institution is.
        </p>
        <ErrorText error={q.error ? errorMessage(q.error) : null} />
        <Table
          head={['When', 'Learner', 'Where', 'Matched', 'Told']}
          empty={q.data?.events.length === 0}
        >
          {q.data?.events.map((e) => (
            <tr key={e.id}>
              <Td>{new Date(e.createdAt).toLocaleString('en-IN')}</Td>
              <Td>
                <span className="font-medium">{e.name}</span>
                <br />
                <span className="text-sm text-muted">{e.email}</span>
              </Td>
              <Td>{WHERE[e.source]}</Td>
              <Td>{RULE[e.rule] ?? e.rule}</Td>
              <Td>
                <Badge tone={e.notified === 'none' ? 'warn' : undefined}>{TOLD[e.notified]}</Badge>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
