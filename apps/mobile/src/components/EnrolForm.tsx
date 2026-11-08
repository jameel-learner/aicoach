import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { api, errorMessage, useOfferings } from '../lib/api';
import { useTheme } from '../lib/theme';
import { Body, Button, Card, ErrorText, Heading, TextField } from './ui';

/** Join a class with its code (institution route) or enrol directly in a subject (decision 6.3). */
export function EnrolForm({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDirect, setShowDirect] = useState(false);
  const offerings = useOfferings();
  const qc = useQueryClient();
  const { colors, radius, minTouchTarget } = useTheme();

  async function submit(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', body });
      await qc.invalidateQueries({ queryKey: ['me'] });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <Heading>Join your class</Heading>
        <Body muted>Your teacher or college gives you an 8-character class code.</Body>
        <TextField
          label="Class code"
          value={code}
          onChangeText={(t) =>
            setCode(
              t
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .slice(0, 10),
            )
          }
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="K7MPQ2XR"
          style={{ letterSpacing: 4, fontSize: 20 }}
        />
        <ErrorText error={error} />
        <Button
          title="Join class"
          onPress={() => void submit('/me/enrolments/join', { joinCode: code })}
          loading={busy}
          disabled={code.length < 6}
        />
      </Card>

      {!showDirect ? (
        <Button
          title="No class code? Study on your own"
          variant="link"
          onPress={() => setShowDirect(true)}
        />
      ) : (
        <Card>
          <Heading>Study on your own</Heading>
          <Body muted>Pick your board, class and subject.</Body>
          {offerings.data?.map((o) => (
            <Pressable
              key={o.id}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void submit('/me/enrolments/direct', { offeringId: o.id })}
              style={({ pressed }) => ({
                minHeight: minTouchTarget,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                padding: 12,
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>
                {o.subject.name}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 14 }}>
                {o.board.code} · {o.level.name}
              </Text>
            </Pressable>
          ))}
          <ErrorText error={offerings.error ? errorMessage(offerings.error) : null} />
        </Card>
      )}
    </>
  );
}
