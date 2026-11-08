import { PARENT_RELATIONSHIPS } from '@aicoach/core';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  Body,
  Button,
  Card,
  Choice,
  ErrorText,
  Screen,
  TextField,
  Title,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useTheme } from '../../lib/theme';

type Relationship = (typeof PARENT_RELATIONSHIPS)[number];

export default function ParentContact() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [relationship, setRelationship] = useState<Relationship>('mother');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const { colors, minTouchTarget } = useTheme();

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      await api('/me/parent-contact', {
        method: 'PUT',
        body: {
          name: name.trim(),
          email: email.trim(),
          relationship,
          acknowledgeSafetyAlerts: ack,
        },
      });
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace('/onboarding/enrol');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Your parent or guardian</Title>
      <Body muted>
        We'll email them once to ask for consent. If you ever seem to be in real distress while
        studying, we'll let them know so you're not alone with it. We never share your answers or
        marks with them through these alerts.
      </Body>
      <Card>
        <TextField
          label="Parent or guardian's name"
          value={name}
          onChangeText={setName}
          autoComplete="name"
        />
        <TextField
          label="Their email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />
        <Choice
          label="Relationship"
          value={relationship}
          onChange={setRelationship}
          options={PARENT_RELATIONSHIPS.map((r) => ({
            value: r,
            label: r[0]!.toUpperCase() + r.slice(1),
          }))}
        />
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: ack }}
          onPress={() => setAck((a) => !a)}
          style={{ flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: minTouchTarget }}
        >
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              borderWidth: 2,
              borderColor: ack ? colors.primary : colors.border,
              backgroundColor: ack ? colors.primary : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {ack ? <Text style={{ color: colors.primaryText, fontWeight: '700' }}>✓</Text> : null}
          </View>
          <View style={{ flex: 1 }}>
            <Body>
              I understand my parent or guardian will be alerted if I seem to be in distress.
            </Body>
          </View>
        </Pressable>
        <ErrorText error={error} />
        <Button
          title="Continue"
          onPress={() => void onSubmit()}
          loading={busy}
          disabled={!name.trim() || !email.trim() || !ack}
        />
      </Card>
    </Screen>
  );
}
