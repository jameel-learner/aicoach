import { expoClient } from '@better-auth/expo/client';
import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from './config';

/** Session cookies are kept in the device's secure storage (Keystore on Android). */
export const authClient = createAuthClient({
  baseURL: API_URL,
  basePath: '/api/auth',
  plugins: [
    expoClient({ scheme: 'aicoach', storagePrefix: 'aicoach', storage: SecureStore }),
    twoFactorClient(),
  ],
});

export const captchaHeaders = (token: string) => ({ headers: { 'x-captcha-response': token } });
