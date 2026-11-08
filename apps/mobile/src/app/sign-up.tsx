import { router } from 'expo-router';
import { useState } from 'react';
import { Turnstile } from '../components/Turnstile';
import { Body, Button, Card, Choice, ErrorText, Screen, TextField, Title } from '../components/ui';
import { authClient, captchaHeaders } from '../lib/auth-client';

export default function SignUp() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'student' | 'teacher'>('student');
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.signUp.email(
        { name: name.trim(), email: email.trim(), password, role } as Parameters<
          typeof authClient.signUp.email
        >[0],
        captchaHeaders(captcha ?? ''),
      );
      setCaptcha(null);
      setResetKey((k) => k + 1);
      if (res.error) throw new Error(res.error.message ?? 'Sign-up failed');
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-up failed');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Screen>
        <Title>Account created</Title>
        <Body>Now sign in. We'll email a code to {email.trim()} to confirm it's you.</Body>
        <Button title="Sign in" onPress={() => router.replace('/sign-in')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Create your account</Title>
      <Card>
        <Choice
          label="I am a"
          value={role}
          onChange={setRole}
          options={[
            { value: 'student', label: 'Student' },
            { value: 'teacher', label: 'Teacher' },
          ]}
        />
        <TextField
          label="Full name"
          value={name}
          onChangeText={setName}
          autoComplete="name"
          textContentType="name"
        />
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
          hint="At least 8 characters"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
        />
        <Turnstile onToken={setCaptcha} resetKey={resetKey} />
        <ErrorText error={error} />
        <Button
          title="Create account"
          onPress={() => void onSubmit()}
          loading={busy}
          disabled={!name.trim() || !email || password.length < 8 || !captcha}
        />
      </Card>
      <Button
        title="I already have an account"
        variant="link"
        onPress={() => router.replace('/sign-in')}
      />
    </Screen>
  );
}
