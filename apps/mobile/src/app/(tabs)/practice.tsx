import { useRouter, type Href } from 'expo-router';
import { ChapterList } from '../../components/ChapterList';
import { Body, Screen, Title } from '../../components/ui';

/** Practice tab: the question bank per chapter (Phase 3). Timed practice with marking comes later. */
export default function Practice() {
  const router = useRouter();
  return (
    <Screen>
      <Title>Practice</Title>
      <Body muted>
        Board-style questions for each chapter, with model answers and what examiners give marks
        for. Try each one first, then check.
      </Body>
      <ChapterList
        mode="practice"
        onOpen={(no) => router.push(`/chapter/${no}?tab=questions` as Href)}
      />
    </Screen>
  );
}
