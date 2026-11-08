import type { Role } from '@aicoach/core';
import type { Db } from '@aicoach/db';
import type { Auth } from './auth';
import type { Notifier } from './lib/notifier';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  APP_ENV: 'development' | 'test' | 'staging' | 'production';
  /** Public base URL of this Worker (API + web app). */
  APP_URL: string;
  /** Origin of the web app during local dev (Vite on :5173). */
  WEB_ORIGIN: string;
  EMAIL_PROVIDER: 'console' | 'resend' | 'memory';
  EMAIL_FROM: string;
  TURNSTILE_SITE_KEY: string;
  // Secrets
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** OpenRouter key: all LLM calls (decision 6). */
  OPENROUTER_API_KEY?: string;
  /**
   * Optional Cloudflare AI Gateway base for OpenRouter, e.g.
   * https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openrouter. Unset = call OpenRouter directly.
   */
  AI_GATEWAY_URL?: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  twoFactorEnabled: boolean;
}

export interface AppVariables {
  db: Db;
  auth: Auth;
  notifier: Notifier;
  user: SessionUser;
}

export type AppBindings = { Bindings: Env; Variables: AppVariables };
