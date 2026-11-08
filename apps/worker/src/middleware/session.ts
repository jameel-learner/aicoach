import { isRole, type Role } from '@aicoach/core';
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env';
import { forbidden, unauthorized } from '../lib/http';

/** Requires a fully signed-in session (2FA completed). Sets `c.var.user`. */
export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  const result = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) throw unauthorized();
  const u = result.user as typeof result.user & {
    role?: unknown;
    twoFactorEnabled?: boolean | null;
  };
  if (!isRole(u.role)) throw forbidden('Account has no valid role');
  c.set('user', {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    twoFactorEnabled: !!u.twoFactorEnabled,
  });
  await next();
});

/** Requires one of the given roles (use after requireAuth). */
export const requireRole = (...roles: Role[]) =>
  createMiddleware<AppBindings>(async (c, next) => {
    if (!roles.includes(c.var.user.role)) throw forbidden();
    await next();
  });
