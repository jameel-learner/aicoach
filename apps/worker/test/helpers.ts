import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { memoryOutbox } from '../src/lib/notifier';

export const BASE = 'http://localhost:8787';
export const PASSWORD = 'correct-horse-battery';

/** Minimal cookie jar: keeps the latest value of each cookie. */
export class Jar {
  private cookies = new Map<string, string>();
  absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  names() {
    return [...this.cookies.keys()];
  }
}

export async function call(
  method: string,
  path: string,
  opts: { jar?: Jar; body?: unknown; form?: Record<string, string>; multipart?: FormData } = {},
): Promise<Response> {
  const headers: Record<string, string> = { origin: BASE };
  if (opts.jar) headers.cookie = opts.jar.header();
  let body: BodyInit | undefined;
  if (opts.multipart) {
    body = opts.multipart; // fetch sets the multipart boundary header
  } else if (opts.form) {
    body = new URLSearchParams(opts.form);
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${BASE}${path}`, { method, headers, body }),
    env as unknown as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  opts.jar?.absorb(res);
  return res;
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let counter = 0;
export function uniqueEmail(prefix: string) {
  counter += 1;
  return `${prefix}.${Date.now()}.${counter}@example.com`;
}

export async function signUp(email: string, role: string, name = 'Test User') {
  return call('POST', '/api/auth/sign-up/email', {
    body: { name, email, password: PASSWORD, role },
  });
}

export function latestOtpFor(email: string): string {
  const msg = [...memoryOutbox].reverse().find((m) => m.to === email && m.tag === '2fa_otp');
  if (!msg) throw new Error(`No OTP email for ${email}`);
  const match = msg.text.match(/\b(\d{6})\b/);
  if (!match) throw new Error('OTP not found in email');
  return match[1]!;
}

/** Full sign-in: password → 2FA challenge → email OTP → session. Returns a jar holding the session. */
export async function signIn(email: string): Promise<Jar> {
  const jar = new Jar();
  const first = await call('POST', '/api/auth/sign-in/email', {
    jar,
    body: { email, password: PASSWORD },
  });
  expect(first.status).toBe(200);
  const firstBody = await json(first);
  expect(firstBody.twoFactorRedirect).toBe(true);
  const send = await call('POST', '/api/auth/two-factor/send-otp', { jar, body: {} });
  expect(send.status).toBe(200);
  const verify = await call('POST', '/api/auth/two-factor/verify-otp', {
    jar,
    body: { code: latestOtpFor(email) },
  });
  expect(verify.status).toBe(200);
  return jar;
}

export async function setRole(email: string, role: string) {
  await env.DB.prepare('UPDATE user SET role = ? WHERE email = ?').bind(role, email).run();
}

/** Sign up + (optionally promote) + sign in. */
export async function createSignedInUser(
  role: 'student' | 'teacher' | 'admin' | 'institution_poc',
  name?: string,
) {
  const email = uniqueEmail(role);
  const signupRole = role === 'student' ? 'student' : 'teacher';
  const res = await signUp(email, signupRole, name ?? `${role} user`);
  expect(res.status).toBe(200);
  if (role === 'admin' || role === 'institution_poc') await setRole(email, role);
  const jar = await signIn(email);
  return { email, jar };
}

export async function seedPilotTaxonomy() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO boards (id, code, name) VALUES ('board_kseab','KSEAB','Karnataka School Examination and Assessment Board')",
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO levels (id, board_id, code, name, sort_order) VALUES ('level_kseab_2puc','board_kseab','2PUC','2nd PUC',12)",
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO subjects (id, code, name, stream) VALUES ('subject_accountancy','ACCOUNTANCY','Accountancy','commerce')",
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO subject_offerings (id, board_id, level_id, subject_id) VALUES ('offering_kseab_2puc_accountancy','board_kseab','level_kseab_2puc','subject_accountancy')",
    ),
  ]);
  return 'offering_kseab_2puc_accountancy';
}
