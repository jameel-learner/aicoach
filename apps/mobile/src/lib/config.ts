import Constants from 'expo-constants';

/**
 * API base URL.
 * - EXPO_PUBLIC_API_URL if set (staging/production builds).
 * - In development: the PC running the Expo dev server, on wrangler's port 8787.
 *   (Expo's hostUri is e.g. "192.168.1.39:8081", the same PC that runs `pnpm dev:worker`.)
 */
function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (host) return `http://${host}:8787`;
  return 'http://localhost:8787';
}

export const API_URL = resolveApiUrl();
