import { ROLE_LABELS } from '@aicoach/core';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Body, Button, Card, ErrorText, Heading, Screen, Title } from '../../components/ui';
import { api, errorMessage, useMe } from '../../lib/api';
import { authClient } from '../../lib/auth-client';

const CONSENT_LABEL = {
  pending: 'Waiting for them to confirm by email',
  verified: 'Confirmed',
  revoked: 'Withdrawn',
} as const;

export default function Me() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!me) return null;

  async function resend() {
    setError(null);
    setMsg(null);
    try {
      await api('/me/parent-contact/resend', { method: 'POST' });
      setMsg('Email sent again.');
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function signOut() {
    await authClient.signOut();
    qc.clear();
  }

  return (
    <Screen>
      <Title>{me.user.name}</Title>
      <Body muted>
        {me.user.email} · {ROLE_LABELS[me.user.role]}
      </Body>

      <Card>
        <Heading>My classes & subjects</Heading>
        {me.enrolments.map((e) => (
          <Body key={e.id}>
            {e.offering.subject} · {e.offering.board} {e.offering.level}
            {e.institution ? ` · ${e.institution.name}` : ' · self-study'}
            {e.classGroup ? ` (${e.classGroup.name})` : ''}
          </Body>
        ))}
        {(me.user.role === 'student' || me.user.role === 'teacher') && (
          <Button
            title="Add a class or subject"
            variant="secondary"
            onPress={() => router.push('/join-class')}
          />
        )}
      </Card>

      {me.parentContact && (
        <Card>
          <Heading>Parent or guardian</Heading>
          <Body>
            {me.parentContact.name} ({me.parentContact.relationship}) · {me.parentContact.email}
          </Body>
          <Body muted>Consent: {CONSENT_LABEL[me.parentContact.consentStatus]}</Body>
          {me.parentContact.consentStatus === 'pending' && (
            <Button title="Send the email again" variant="link" onPress={() => void resend()} />
          )}
          {msg ? <Body muted>{msg}</Body> : null}
          <ErrorText error={error} />
        </Card>
      )}

      <Button title="Sign out" variant="secondary" onPress={() => void signOut()} />
    </Screen>
  );
}
