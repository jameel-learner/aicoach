# PRODUCTION: Live service for real users

> **Status: not created yet.** Planned before the institutional pilot. This page fixes the shape now so production stays separate from local and staging.

| | Production (planned) |
|---|---|
| Web app + API | A custom domain you own (e.g. `app.<your-domain>`), not workers.dev |
| Cloudflare plan | **Workers Paid** (US$5/month) |
| Database | Separate D1 database `aicoach-prod` with Time Travel backups; never shared with staging |
| Email | Resend with a verified sender domain (`EMAIL_PROVIDER=resend`) |
| Bot protection | Real Turnstile widget for the production hostname |
| Secrets | Separate values from staging (`wrangler secret put … --env production`) |
| Mobile app | Store build via EAS (`EXPO_PUBLIC_APP_ENV=production`), not Expo Go |
| Deploys | Only after the same version passed on staging; tagged release in git |

## Promotion rule

```
LOCAL (during a phase)  →  STAGING (end of phase, sign-off)  →  PRODUCTION (release, after pilot readiness)
```

A version reaches production only after it has run on staging.

## To set up (when we get there)

1. Domain added to Cloudflare; Workers Paid enabled.
2. `wrangler d1 create aicoach-prod`, plus an `env.production` block in `apps\worker\wrangler.jsonc` (own `database_id`, `APP_URL`, `WEB_ORIGIN`, `EMAIL_PROVIDER=resend`, real `TURNSTILE_SITE_KEY`) and a custom-domain route.
3. Secrets: `BETTER_AUTH_SECRET`, `TURNSTILE_SECRET_KEY`, `RESEND_API_KEY`, `OPENROUTER_API_KEY` with `--env production`.
4. Root scripts `deploy:production`, `logs:production` and `make-admin:production`, mirroring staging.
5. Mobile: production URL in `apps\mobile\src\lib\config.ts` (`ENV_URLS.production`), EAS build profile `production`.
6. Monitoring/alerts, backup restore drill, DPDP compliance checklist (architecture §7, Phase 9).

This page becomes the production runbook (deploy, rollback, incident steps) once it exists.
