import { mathToText } from '@aicoach/core';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Pill } from '../components/ChapterList';
import { Body, Button, Card, ErrorText, Heading, Screen, Title } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useEnrolment } from '../lib/enrolment-context';
import { useArtefacts, type Artefact } from '../lib/session';
import { useTheme } from '../lib/theme';

/**
 * The learner's locker (spec 5.5.10): the cards and memory hooks they made themselves. Their own
 * cards come up in the chapter's memorise sessions; a hook is shown with its card.
 */
export default function Locker() {
  const router = useRouter();
  const qc = useQueryClient();
  const { active } = useEnrolment();
  const list = useArtefacts(active?.id);
  const [error, setError] = useState<string | null>(null);

  async function remove(a: Artefact) {
    setError(null);
    try {
      await api(`/learner/artefacts/${a.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['learner', 'artefacts'] });
      void qc.invalidateQueries({ queryKey: ['study'] });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const items = list.data?.artefacts ?? [];
  const cards = items.filter((a) => a.kind === 'card');
  const hooks = items.filter((a) => a.kind === 'mnemonic');
  return (
    <Screen>
      <Button title="‹ Back" variant="link" onPress={() => router.back()} />
      <Title>My locker</Title>
      <Body muted>What you made yourself. Only you can see it.</Body>
      {list.error && <ErrorText error={errorMessage(list.error)} />}
      <ErrorText error={error} />
      {list.data && items.length === 0 && (
        <Card>
          <Heading>Nothing here yet</Heading>
          <Body muted>
            At the end of a study session you can make your own card, and in a memorise session a
            memory hook for any card. They are kept here.
          </Body>
        </Card>
      )}
      {cards.length > 0 && <Heading>My cards ({cards.length})</Heading>}
      {cards.map((a) => (
        <Item key={a.id} a={a} onRemove={() => void remove(a)}>
          <Text style={{ fontWeight: '700' }}>{mathToText(a.content.front ?? '')}</Text>
          {'\n'}
          {mathToText(a.content.back ?? '')}
        </Item>
      ))}
      {hooks.length > 0 && <Heading>My memory hooks ({hooks.length})</Heading>}
      {hooks.map((a) => (
        <Item key={a.id} a={a} onRemove={() => void remove(a)}>
          <Text style={{ fontWeight: '700' }}>{mathToText(a.content.text ?? '')}</Text>
          {a.content.for ? `\nFor: ${mathToText(a.content.for)}` : ''}
        </Item>
      ))}
    </Screen>
  );
}

function Item({
  a,
  onRemove,
  children,
}: {
  a: Artefact;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const { colors, fontSize } = useTheme();
  const [confirm, setConfirm] = useState(false);
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Pill label={`Chapter ${a.chapter}`} strong />
        {a.topic ? <Pill label={a.topic} /> : null}
      </View>
      <Text style={{ color: colors.text, fontSize: fontSize.md, lineHeight: 24 }}>{children}</Text>
      {confirm ? (
        <View style={{ flexDirection: 'row', gap: 16 }}>
          <Button title="Yes, remove it" variant="link" onPress={onRemove} />
          <Button title="Keep it" variant="link" onPress={() => setConfirm(false)} />
        </View>
      ) : (
        <Button title="Remove" variant="link" onPress={() => setConfirm(true)} />
      )}
    </Card>
  );
}
