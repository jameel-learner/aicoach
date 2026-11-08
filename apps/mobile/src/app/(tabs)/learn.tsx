import { Body, Card, Heading, Screen, Title } from '../../components/ui';

export default function Learn() {
  return (
    <Screen>
      <Title>Learn</Title>
      <Card>
        <Heading>Coming next</Heading>
        <Body muted>
          Ask questions about your textbook and get answers that show the chapter and page they came
          from. Then come notes for every marks weightage and quick memory maps.
        </Body>
      </Card>
    </Screen>
  );
}
