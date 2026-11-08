import { EnrolmentSwitcher } from '../../components/EnrolmentSwitcher';
import { Body, Card, Heading, Screen, Title } from '../../components/ui';
import { useMe } from '../../lib/api';
import { useEnrolment } from '../../lib/enrolment-context';

export default function Home() {
  const { data: me } = useMe();
  const { active } = useEnrolment();
  if (!me) return null;
  const firstName = me.user.name.split(' ')[0];

  if (me.user.role === 'admin' || me.user.role === 'institution_poc') {
    return (
      <Screen>
        <Title>Hi {firstName}</Title>
        <Card>
          <Body>
            Institution and admin tools are in the AI Coach web app. Sign in there with the same
            email.
          </Body>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Hi {firstName}</Title>
      <EnrolmentSwitcher />
      {active && (
        <Card>
          <Heading>{active.offering.subject}</Heading>
          <Body muted>
            {active.offering.board} · {active.offering.level}
            {active.institution ? ` · ${active.institution.name}` : ' · self-study'}
            {active.classGroup ? ` · ${active.classGroup.name}` : ''}
          </Body>
        </Card>
      )}
      <Card>
        <Heading>Your study sessions will appear here</Heading>
        <Body muted>
          Short 7 to 12 minute units, each with a clear finish, that you can pause and pick up again
          with one tap. Your textbook is being prepared, and we'll show sessions here as soon as
          they're ready.
        </Body>
      </Card>
    </Screen>
  );
}
