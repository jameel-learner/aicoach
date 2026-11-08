import type { ApiError } from '@aicoach/core';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Same-origin JSON fetch with cookies. Throws ApiRequestError with the server's message. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
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
      message +=
        ': ' +
        details
          .map(
            (d: { path?: string; message?: string }) => `${d.path ? d.path + ' ' : ''}${d.message}`,
          )
          .join('; ');
    }
    throw new ApiRequestError(res.status, payload.error?.code ?? 'error', message, details);
  }
  return (await res.json()) as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
