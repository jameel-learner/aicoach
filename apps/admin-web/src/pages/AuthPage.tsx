import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import { Turnstile, type TurnstileHandle } from '../components/Turnstile';
import { Button, ErrorText, Field, Input, Select } from '../components/ui';
import { authClient, captchaHeaders } from '../lib/auth-client';

type Step = 'signin' | 'signup' | 'otp' | 'signed-up';

export function AuthPage() {
  const [step, setStep] = useState<Step>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'teacher' | 'student'>('teacher');
  const [code, setCode] = useState('');
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const turnstile = useRef<TurnstileHandle>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const onSignIn = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await authClient.signIn.email({ email, password }, captchaHeaders(captcha ?? ''));
      turnstile.current?.reset();
      if (res.error) throw new Error(res.error.message ?? 'Sign-in failed');
      if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
        const sent = await authClient.twoFactor.sendOtp();
        if (sent.error) throw new Error(sent.error.message ?? 'Could not send the code');
        setStep('otp');
        return;
      }
      await qc.invalidateQueries({ queryKey: ['me'] });
      await navigate({ to: '/' });
    });
  };

  const onSignUp = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await authClient.signUp.email(
        { name, email, password, role } as Parameters<typeof authClient.signUp.email>[0],
        captchaHeaders(captcha ?? ''),
      );
      turnstile.current?.reset();
      if (res.error) throw new Error(res.error.message ?? 'Sign-up failed');
      setPassword('');
      setStep('signed-up');
    });
  };

  const onVerify = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await authClient.twoFactor.verifyOtp({ code: code.trim() });
      if (res.error) throw new Error(res.error.message ?? 'That code did not work');
      await qc.invalidateQueries({ queryKey: ['me'] });
      await navigate({ to: '/' });
    });
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-3xl font-bold">AI Coach</h1>
      <p className="mb-6 text-muted">Admin, institution and teacher workspace</p>

      <div className="rounded-2xl border border-border bg-surface p-6">
        {step === 'signin' && (
          <form onSubmit={onSignIn} className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold">Sign in</h2>
            <Field label="Email">
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Turnstile ref={turnstile} onToken={setCaptcha} />
            <ErrorText error={error} />
            <Button type="submit" disabled={busy || !captcha}>
              {busy ? 'Signing in…' : 'Continue'}
            </Button>
            <p className="text-sm text-muted">
              We'll email you a 6-digit code to finish signing in.{' '}
              <button
                type="button"
                className="font-semibold text-primary underline"
                onClick={() => {
                  setError(null);
                  setStep('signup');
                }}
              >
                Create an account
              </button>
            </p>
          </form>
        )}

        {step === 'signup' && (
          <form onSubmit={onSignUp} className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold">Create an account</h2>
            <Field label="Full name">
              <Input
                required
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Email">
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password" hint="At least 8 characters">
              <Input
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="I am a" hint="Institution POC and Admin access is granted by an Admin.">
              <Select
                value={role}
                onChange={(e) => setRole(e.target.value as 'teacher' | 'student')}
              >
                <option value="teacher">Teacher</option>
                <option value="student">Student</option>
              </Select>
            </Field>
            <Turnstile ref={turnstile} onToken={setCaptcha} />
            <ErrorText error={error} />
            <Button type="submit" disabled={busy || !captcha}>
              {busy ? 'Creating…' : 'Create account'}
            </Button>
            <button
              type="button"
              className="text-sm font-semibold text-primary underline"
              onClick={() => {
                setError(null);
                setStep('signin');
              }}
            >
              I already have an account
            </button>
          </form>
        )}

        {step === 'signed-up' && (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold">Account created</h2>
            <p className="text-muted">
              Sign in now. We'll email a code to {email} to confirm it's you.
            </p>
            <Button onClick={() => setStep('signin')}>Sign in</Button>
          </div>
        )}

        {step === 'otp' && (
          <form onSubmit={onVerify} className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold">Enter your code</h2>
            <p className="text-muted">
              We sent a 6-digit code to {email}. It expires in 10 minutes.
            </p>
            <Field label="Code">
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="text-center text-2xl tracking-[0.4em]"
              />
            </Field>
            <ErrorText error={error} />
            <Button type="submit" disabled={busy || code.length !== 6}>
              {busy ? 'Checking…' : 'Verify and sign in'}
            </Button>
            <button
              type="button"
              className="text-sm font-semibold text-primary underline"
              onClick={() =>
                void run(async () => {
                  const r = await authClient.twoFactor.sendOtp();
                  if (r.error) throw new Error(r.error.message ?? 'Could not resend');
                })
              }
            >
              Send a new code
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
