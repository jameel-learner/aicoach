import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password';
import {
  call,
  createSignedInUser,
  Jar,
  json,
  latestOtpFor,
  PASSWORD,
  signUp,
  uniqueEmail,
} from './helpers';

describe('health', () => {
  it('responds', async () => {
    const res = await call('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, env: 'test' });
  });
});

describe('password hashing (PBKDF2)', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('s3cret-password');
    expect(hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(await verifyPassword({ hash, password: 's3cret-password' })).toBe(true);
    expect(await verifyPassword({ hash, password: 'wrong' })).toBe(false);
    expect(await verifyPassword({ hash: 'garbage', password: 's3cret-password' })).toBe(false);
  });
});

describe('sign-up', () => {
  it('rejects self-assigned admin or POC roles', async () => {
    for (const role of ['admin', 'institution_poc']) {
      const res = await signUp(uniqueEmail('evil'), role);
      expect(res.status).toBe(400);
    }
  });

  it('does not start a session and enables 2FA by default', async () => {
    const email = uniqueEmail('new');
    const jar = new Jar();
    const res = await call('POST', '/api/auth/sign-up/email', {
      jar,
      body: { name: 'New Student', email, password: PASSWORD, role: 'student' },
    });
    expect(res.status).toBe(200);
    expect((await call('GET', '/api/me', { jar })).status).toBe(401);
    const row = await env.DB.prepare(
      'SELECT role, two_factor_enabled, email_verified FROM user WHERE email = ?',
    )
      .bind(email)
      .first<{ role: string; two_factor_enabled: number; email_verified: number }>();
    expect(row).toEqual({ role: 'student', two_factor_enabled: 1, email_verified: 0 });
  });
});

describe('sign-in with email two-step verification', () => {
  it('password alone does not grant a session', async () => {
    const email = uniqueEmail('s');
    await signUp(email, 'student');
    const jar = new Jar();
    const res = await call('POST', '/api/auth/sign-in/email', {
      jar,
      body: { email, password: PASSWORD },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).twoFactorRedirect).toBe(true);
    expect((await call('GET', '/api/me', { jar })).status).toBe(401);
  });

  it('wrong password is rejected', async () => {
    const email = uniqueEmail('s');
    await signUp(email, 'student');
    const res = await call('POST', '/api/auth/sign-in/email', {
      body: { email, password: 'not-the-password' },
    });
    expect(res.status).toBe(401);
  });

  it('a wrong code is rejected, the right code signs in and verifies the email', async () => {
    const email = uniqueEmail('s');
    await signUp(email, 'student');
    const jar = new Jar();
    await call('POST', '/api/auth/sign-in/email', { jar, body: { email, password: PASSWORD } });
    await call('POST', '/api/auth/two-factor/send-otp', { jar, body: {} });
    const code = latestOtpFor(email);
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await call('POST', '/api/auth/two-factor/verify-otp', {
      jar,
      body: { code: wrong },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const good = await call('POST', '/api/auth/two-factor/verify-otp', { jar, body: { code } });
    expect(good.status).toBe(200);

    const me = await json(await call('GET', '/api/me', { jar }));
    expect(me.user.email).toBe(email);
    const row = await env.DB.prepare('SELECT email_verified FROM user WHERE email = ?')
      .bind(email)
      .first<{ email_verified: number }>();
    expect(row?.email_verified).toBe(1);
  });

  it.each(['student', 'teacher', 'institution_poc', 'admin'] as const)(
    'end-to-end sign-up → 2FA → /me works for role %s',
    async (role) => {
      const { email, jar } = await createSignedInUser(role);
      const me = await json(await call('GET', '/api/me', { jar }));
      expect(me.user).toMatchObject({ email, role, twoFactorEnabled: true });
    },
  );

  it('sign-out ends the session', async () => {
    const { jar } = await createSignedInUser('student');
    expect((await call('POST', '/api/auth/sign-out', { jar, body: {} })).status).toBe(200);
    expect((await call('GET', '/api/me', { jar })).status).toBe(401);
  });
});

describe('dev outbox endpoint', () => {
  it('is not available outside development', async () => {
    expect((await call('GET', '/api/dev/outbox')).status).toBe(404);
  });
});
