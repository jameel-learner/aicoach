import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
  plugins: [twoFactorClient()],
});

/** Pass the Turnstile token as the header Better Auth's captcha plugin expects. */
export const captchaHeaders = (token: string) => ({ headers: { 'x-captcha-response': token } });
