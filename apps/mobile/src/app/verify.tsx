import { useQueryClient } from '@tanstack/react-query';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Body, Button, Card, ErrorText, Screen, TextField, Title } from '../components/ui';
import { authClient } from '../lib/auth-client';

export default function Verify() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  // This screen is only valid right after a password sign-in (which passes the email).
  // Opened any other way (e.g. as the router's fallback when signed out), go to sign-in.
  if (!email) return <Redirect href="/sign-in" />;

  async function onVerify() {
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.twoFactor.verifyOtp({ code });
      if (res.error) throw new Error(res.error.message ?? 'That code did not work');
      await qc.invalidateQueries({ queryKey: ['me'] });
      // The root navigator switches to the app (or onboarding) once the session exists.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code did not work');
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setError(null);
    const res = await authClient.twoFactor.sendOtp();
    if (res.error) setError(res.error.message ?? 'Could not send a new code');
    else setInfo('A new code is on its way.');
  }

  return (
    <Screen>
      <Title>Enter your code</Title>
      <Body muted>
        We sent a 6-digit code to {email ?? 'your email'}. It expires in 10 minutes.
      </Body>
      <Card>
        <TextField
          label="Code"
          value={code}
          onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          maxLength={6}
          style={{ fontSize: 28, letterSpacing: 8, textAlign: 'center' }}
        />
        <ErrorText error={error} />
        {info ? <Body muted>{info}</Body> : null}
        <Button
          title="Verify and sign in"
          onPress={() => void onVerify()}
          loading={busy}
          disabled={code.length !== 6}
        />
        <Button title="Send a new code" variant="link" onPress={() => void onResend()} />
      </Card>
      <Button title="Back to sign in" variant="link" onPress={() => router.replace('/sign-in')} />
    </Screen>
  );
}
