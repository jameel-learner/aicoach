import { EnrolForm } from '../../components/EnrolForm';
import { Body, Screen, Title } from '../../components/ui';

export default function Enrol() {
  // When the enrolment succeeds, /me refreshes and the root navigator moves to the app.
  return (
    <Screen>
      <Title>What are you studying?</Title>
      <Body muted>You can add more classes or subjects later from your profile.</Body>
      <EnrolForm onDone={() => {}} />
    </Screen>
  );
}
