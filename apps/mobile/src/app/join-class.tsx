import { router } from 'expo-router';
import { EnrolForm } from '../components/EnrolForm';
import { Button, Screen, Title } from '../components/ui';

export default function JoinClass() {
  return (
    <Screen>
      <Title>Add a class or subject</Title>
      <EnrolForm onDone={() => router.back()} />
      <Button title="Cancel" variant="link" onPress={() => router.back()} />
    </Screen>
  );
}
