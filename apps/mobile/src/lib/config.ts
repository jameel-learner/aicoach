import Constants from 'expo-constants';

/**
 * Which backend this app build talks to. Set by the start script, not by hand:
 *   pnpm dev:mobile            → local     (your PC running `pnpm dev:worker`)
 *   pnpm dev:mobile:staging    → staging   (Cloudflare)
 *   production                 → added when PROD exists (docs/environments/production.md)
 */
export type AppEnv = 'local' | 'staging' | 'production';

const ENV_URLS: Record<Exclude<AppEnv, 'local'>, string> = {
  staging: 'https://aicoach-api-staging.jameel-outskill.workers.dev',
  production: '', // not deployed yet
};

function resolveEnv(): AppEnv {
  const v = process.env.EXPO_PUBLIC_APP_ENV;
  return v === 'staging' || v === 'production' ? v : 'local';
}

function resolveApiUrl(env: AppEnv): string {
  if (env !== 'local') {
    const url = ENV_URLS[env];
    if (!url) throw new Error(`No API URL configured for "${env}" yet`);
    return url;
  }
  // Local: the same PC that serves the Expo bundle runs wrangler on port 8787.
  // Expo's hostUri is e.g. "192.168.1.39:8081".
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return host ? `http://${host}:8787` : 'http://localhost:8787';
}

export const APP_ENV: AppEnv = resolveEnv();
export const API_URL = resolveApiUrl(APP_ENV);

/** Short label shown in the app so it's always clear which server you're on. */
export const SERVER_LABEL =
  APP_ENV === 'local'
    ? `Local server · ${API_URL.replace(/^https?:\/\//, '')}`
    : `${APP_ENV.toUpperCase()} server`;
