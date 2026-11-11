import { createDb } from '@aicoach/db';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { getAuth } from './auth';
import type { AppBindings, Env } from './env';
import { AppError } from './lib/http';
import { createNotifier, memoryOutbox } from './lib/notifier';
import { runScheduled } from './cron';
import { adminRoutes } from './routes/admin';
import { bookRoutes } from './routes/books';
import { strategyRoutes } from './routes/strategy';
import { materialRoutes } from './routes/material';
import { savedAnswerRoutes } from './routes/saved-answers';
import { evalRoutes } from './routes/evals';
import { aiRoutes } from './routes/ai';
import { askRoutes } from './routes/ask';
import { adminCreditRoutes, creditRoutes } from './routes/credits';
import { modelRoutes } from './routes/models';
import { catalogRoutes } from './routes/catalog';
import { institutionRoutes } from './routes/institution';
import { meRoutes } from './routes/me';
import { parentConsentRoutes } from './routes/parent-consent';
import { teacherRoutes } from './routes/teacher';
import { reviewRoutes } from './routes/review';
import { learnerMaterialRoutes } from './routes/learn-material';

export function createApp() {
  const app = new Hono<AppBindings>().basePath('/api');

  // Per-request services. Workers only expose bindings inside the request, so build them here.
  app.use('*', async (c, next) => {
    c.set('db', createDb(c.env.DB));
    c.set('notifier', createNotifier(c.env));
    c.set('auth', getAuth(c.env));
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
  app.route('/admin/models', modelRoutes);
  app.route('/admin/books', bookRoutes);
  app.route('/admin/strategy', strategyRoutes);
  app.route('/admin/material', materialRoutes);
  app.route('/admin/saved-answers', savedAnswerRoutes);
  app.route('/admin/evals', evalRoutes);
  app.route('/admin/credits', adminCreditRoutes);
  app.route('/admin', adminRoutes);
  app.route('/credits', creditRoutes);
  app.route('/ai', aiRoutes);
  app.route('/ask', askRoutes);
  app.route('/review', reviewRoutes);
  app.route('/material', learnerMaterialRoutes);
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

// NOTE: the Worker's main module must only export handlers; Workers treats named exports as entry points.

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduled(controller.cron, env));
  },
} satisfies ExportedHandler<Env>;

// Durable Workflow classes must be exported from the entry module (they are functions/classes).
export { IngestBookWorkflow } from './content/workflow';
export { CompileStrategyWorkflow } from './strategy/workflow';
export { GenerateAssetsWorkflow } from './assets/workflow';
