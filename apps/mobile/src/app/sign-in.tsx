import { router } from 'expo-router';
import { useState } from 'react';
import { Turnstile } from '../components/Turnstile';
import { Body, Button, Card, ErrorText, Screen, TextField, Title } from '../components/ui';
import { authClient, captchaHeaders } from '../lib/auth-client';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.signIn.email(
        { email: email.trim(), password },
        captchaHeaders(captcha ?? ''),
      );
      setCaptcha(null);
      setResetKey((k) => k + 1);
      if (res.error) throw new Error(res.error.message ?? 'Sign-in failed');
      if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
        const sent = await authClient.twoFactor.sendOtp();
        if (sent.error) throw new Error(sent.error.message ?? 'Could not send your code');
        router.push({ pathname: '/verify', params: { email: email.trim() } });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>AI Coach</Title>
      <Body muted>Your board-exam study partner.</Body>
      <Card>
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
        />
        <TextField
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
        />
        <Turnstile onToken={setCaptcha} resetKey={resetKey} />
        <ErrorText error={error} />
        <Button
          title="Continue"
          onPress={() => void onSubmit()}
          loading={busy}
          disabled={!email || !password || !captcha}
        />
        <Body muted>We'll email you a 6-digit code to finish signing in.</Body>
      </Card>
      <Button
        title="New here? Create an account"
        variant="link"
        onPress={() => router.push('/sign-up')}
      />
    </Screen>
  );
}
