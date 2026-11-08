import type { ApiError, MeResponse, OfferingView } from '@aicoach/core';
import { useQuery } from '@tanstack/react-query';
import { authClient } from './auth-client';
import { API_URL } from './config';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** JSON request to the AI Coach API, carrying the session cookie from secure storage. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const cookie = await authClient.getCookie();
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'omit',
    });
  } catch {
    throw new ApiRequestError(
      0,
      'network',
      "Can't reach AI Coach. Check your internet connection.",
    );
  }
  if (!res.ok) {
    let payload: Partial<ApiError> = {};
    try {
      payload = (await res.json()) as ApiError;
    } catch {
      /* not JSON */
    }
    const details = payload.error?.details;
    let message = payload.error?.message ?? `Request failed (${res.status})`;
    if (Array.isArray(details) && details.length) {
      message = details.map((d: { message?: string }) => d.message).join('. ');
    }
    throw new ApiRequestError(res.status, payload.error?.code ?? 'error', message);
  }
  return (await res.json()) as T;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/me'),
    enabled,
    staleTime: 30_000,
  });
}

export function useOfferings() {
  return useQuery({
    queryKey: ['offerings'],
    queryFn: () => api<OfferingView[]>('/catalog/offerings'),
  });
}

export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api<{ turnstileSiteKey: string }>('/config'),
    staleTime: Infinity,
  });
}
