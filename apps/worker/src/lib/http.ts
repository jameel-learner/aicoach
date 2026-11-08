import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

export class AppError extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(status, { message });
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const unauthorized = () => new AppError(401, 'unauthorized', 'Sign in required');
export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string) => new AppError(409, 'conflict', message);

/** Parse and validate a JSON body with a Zod schema; throws a 400 with field errors on failure. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Request body must be JSON');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw badRequest(
      'Validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** SQLite UNIQUE violations surface as errors mentioning "UNIQUE constraint failed". */
export function isUniqueViolation(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`
      : String(err);
  return msg.includes('UNIQUE constraint failed');
}
