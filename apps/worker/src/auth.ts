import { expo } from '@better-auth/expo';
import { isSelfSignupRole } from '@aicoach/core';
import { createDb, schema, user as userTable } from '@aicoach/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { captcha, twoFactor } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import type { Env } from './env';
import { otpEmail } from './lib/emails';
import { createNotifier } from './lib/notifier';
import { hashPassword, verifyPassword } from './lib/password';

/**
 * Better Auth configuration (architecture §5.1, spec 4.1):
 * - email + password registration
 * - two-step verification ON by default: every new user gets twoFactorEnabled=true, and each
 *   sign-in is completed with a 6-digit code sent by email
 * - sign-up does NOT create a session; the first sign-in goes through the email code, which also
 *   proves the user owns the address (we then mark emailVerified=true)
 * - roles: users may self-select only "student" or "teacher"
 */
export function createAuth(env: Env, ctx?: Pick<ExecutionContext, 'waitUntil'>) {
  const db = createDb(env.DB);
  const notifier = createNotifier(env);
  const isTest = env.APP_ENV === 'test';

  const trustedOrigins = [env.APP_URL, env.WEB_ORIGIN, 'aicoach://'];
  // Expo Go during development uses exp://<LAN-IP>:<port> origins.
  if (env.APP_ENV === 'development')
    trustedOrigins.push('exp://', 'exp://**', 'exp://192.168.*.*:*/**');

  return betterAuth({
    appName: 'AI Coach',
    baseURL: env.APP_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins,
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: false,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    user: {
      additionalFields: {
        role: { type: 'string', required: false, defaultValue: 'student', input: true },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // refresh daily
    },
    databaseHooks: {
      user: {
        create: {
          before: async (data) => {
            const role = (data as { role?: unknown }).role ?? 'student';
            if (!isSelfSignupRole(role)) {
              throw new APIError('BAD_REQUEST', {
                message: 'You can sign up as a student or a teacher only',
              });
            }
            return { data: { ...data, role, twoFactorEnabled: true } };
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (hookCtx) => {
        // A successful email-code verification proves ownership of the address.
        if (hookCtx.path === '/two-factor/verify-otp') {
          const newSession = hookCtx.context.newSession;
          if (newSession && !newSession.user.emailVerified) {
            await db
              .update(userTable)
              .set({ emailVerified: true })
              .where(eq(userTable.id, newSession.user.id));
          }
        }
      }),
    },
    rateLimit: {
      enabled: !isTest,
      storage: 'database',
      window: 60,
      max: 100,
      // Per-IP limits sized for a classroom behind one school NAT (~60 students signing in together).
      // Bots are stopped by Turnstile; OTP guessing is limited per sign-in attempt by the 2FA plugin.
      customRules: {
        '/sign-in/email': { window: 60, max: 60 },
        '/sign-up/email': { window: 60, max: 30 },
        '/two-factor/send-otp': { window: 60, max: 60 },
        '/two-factor/verify-otp': { window: 60, max: 120 },
      },
    },
    advanced: {
      ...(ctx ? { backgroundTasks: { handler: (p: Promise<unknown>) => ctx.waitUntil(p) } } : {}),
    },
    plugins: [
      twoFactor({
        issuer: 'AI Coach',
        // Every sign-in needs the code; no "remember this device" in Phase 0.
        trustDeviceMaxAge: 0,
        otpOptions: {
          period: 10 * 60 * 1000, // ms, code valid for 10 minutes
          sendOTP: async ({ user, otp }) => {
            await notifier.send(otpEmail(user.email, user.name, otp));
          },
        },
      }),
      expo(),
      ...(env.TURNSTILE_SECRET_KEY
        ? [
            captcha({
              provider: 'cloudflare-turnstile',
              secretKey: env.TURNSTILE_SECRET_KEY,
              endpoints: ['/sign-up/email', '/sign-in/email'],
            }),
          ]
        : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
