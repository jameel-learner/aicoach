import { createDb } from '@aicoach/db';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { createAuth } from './auth';
import type { AppBindings, Env } from './env';
import { AppError } from './lib/http';
import { createNotifier, memoryOutbox } from './lib/notifier';
import { adminRoutes } from './routes/admin';
import { catalogRoutes } from './routes/catalog';
import { institutionRoutes } from './routes/institution';
import { meRoutes } from './routes/me';
import { parentConsentRoutes } from './routes/parent-consent';
import { teacherRoutes } from './routes/teacher';

export function createApp() {
  const app = new Hono<AppBindings>().basePath('/api');

  // Per-request services. Workers only expose bindings inside the request, so build them here.
  app.use('*', async (c, next) => {
    c.set('db', createDb(c.env.DB));
    c.set('notifier', createNotifier(c.env));
    c.set('auth', createAuth(c.env, c.executionCtx));
    await next();
  });

  // The web app is served from the same origin in production; CORS only matters for local dev (Vite on :5173).
  app.use('*', async (c, next) => {
    const allowed = [c.env.WEB_ORIGIN, c.env.APP_URL];
    return cors({
      origin: (origin) => (allowed.includes(origin) ? origin : null),
      credentials: true,
      allowHeaders: ['content-type', 'authorization', 'x-captcha-response'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    })(c, next);
  });

  app.get('/health', (c) => c.json({ ok: true, env: c.env.APP_ENV }));
  app.get('/config', (c) => c.json({ turnstileSiteKey: c.env.TURNSTILE_SITE_KEY }));

  // Development only: read recently "sent" emails (sign-in codes, consent links) for local testing.
  app.get('/dev/outbox', (c) => {
    if (c.env.APP_ENV !== 'development')
      return c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404);
    const to = c.req.query('to')?.toLowerCase();
    return c.json(memoryOutbox.filter((m) => !to || m.to.toLowerCase() === to).slice(-20));
  });

  app.on(['GET', 'POST'], '/auth/*', (c) => c.var.auth.handler(c.req.raw));

  app.route('/me', meRoutes);
  app.route('/catalog', catalogRoutes);
  app.route('/admin', adminRoutes);
  app.route('/institutions', institutionRoutes);
  app.route('/teacher', teacherRoutes);
  app.route('/parent-consent', parentConsentRoutes);

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        err.status,
      );
    }
    if (err instanceof HTTPException) {
      return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
    }
    console.error('Unhandled error', err);
    return c.json({ error: { code: 'internal', message: 'Something went wrong' } }, 500);
  });

  return app;
}

const app = createApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
