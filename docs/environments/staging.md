# STAGING: The cloud test copy on Cloudflare

**Use this only at the end of a phase**, after the phase works locally and you're ready to sign it off. Deploy, test the finished phase here, then move on to the next phase. During a phase, keep using [LOCAL](local.md).

| | Staging |
|---|---|
| Web app + API | **https://aicoach-api-staging.jameel-outskill.workers.dev** |
| Cloudflare account | jameel.outskill@gmail.com (free plan) |
| Database | D1 `aicoach-staging` (region APAC), separate from local; **local data is not copied** |
| Sign-in codes & emails | Live Cloudflare log: `pnpm logs:staging` (no real email yet) |
| Secrets | Stored in Cloudflare (`wrangler secret put … --env staging`); never in git |
| AI calls (from Phase 1) | Same OpenRouter account; staging usage costs real credits |
| Live since | 2026-11-08 (Phase 0) |

Contents: [1. End-of-phase checklist](#1-end-of-phase-checklist) · [2. Deploy](#2-deploy) · [3. Test on staging](#3-test-on-staging) · [4. Secrets & config](#4-secrets--config) · [5. Before real users](#5-before-real-users) · [6. How staging was created](#6-how-staging-was-created) · [7. Troubleshooting](#7-troubleshooting)

---

## 1. End-of-phase checklist

Do these in order when a phase is complete locally:

1. All tests green locally: `pnpm typecheck` and `pnpm test`.
2. Phase work committed and pushed; the GitHub CI run is green.
3. **New secrets for this phase** are set on staging (each phase section in [progress.md](../progress.md) lists them; see [§4](#4-secrets--config)).
4. **Deploy** ([§2](#2-deploy)).
5. **Test** the phase on staging ([§3](#3-test-on-staging)).
6. Sign off: tell Claude the phase is done on staging. Claude records it in progress.md and starts the next phase.

---

## 2. Deploy

```powershell
cd E:\repository\aicoach
pnpm deploy:staging
```

This builds the web app, applies any new database migrations to the staging database (answer **y** if asked to continue), and deploys the Worker. It ends by printing the staging address and a *Current Version ID*.

**First deploy of a fresh staging database only** (already done for the current one):

```powershell
pnpm --filter @aicoach/worker db:seed:staging
```

---

## 3. Test on staging

**Terminal 1: live log** (sign-in codes and consent links appear here):

```powershell
cd E:\repository\aicoach
pnpm logs:staging
```

Look for `[notify:email] (2fa_otp)` → `Your sign-in code is ######`.

**Web:** open https://aicoach-api-staging.jameel-outskill.workers.dev and sign up / sign in exactly as in the [local walkthrough](local.md#3-first-time-walkthrough-10-steps). Staging has its **own** accounts; sign up again there.

**Make yourself Admin on staging** (after signing up on the staging site as Teacher):

```powershell
pnpm make-admin:staging jameel.learner@gmail.com
```

**Phone against staging** (Terminal 2):

```powershell
pnpm dev:mobile:staging
```

It prints `AI Coach mobile → STAGING backend`, and the app shows **"STAGING server"** on the sign-in screen and the **Me** tab. This works over mobile data too, not just Wi-Fi. Run `pnpm dev:mobile` again to go back to local.

**Quick health check:** https://aicoach-api-staging.jameel-outskill.workers.dev/api/health shows `"env":"staging"`.

---

## 4. Secrets & config

Secrets are set once per environment from `apps\worker`; each command asks you to paste the value.

```powershell
cd E:\repository\aicoach\apps\worker
pnpm exec wrangler secret put <NAME> --env staging
pnpm exec wrangler secret list --env staging   # see which exist (values are never shown)
```

| Secret | Status | Needed from |
|---|---|---|
| `BETTER_AUTH_SECRET` | ✅ set (random, different from local) | Phase 0 |
| `TURNSTILE_SECRET_KEY` | ✅ set (Cloudflare **test** key) | Phase 0 |
| `OPENROUTER_API_KEY` | ⬜ set at the end of Phase 1 | Phase 1 |
| `RESEND_API_KEY` | ⬜ when a sender domain exists | Pilot |

Non-secret settings are under `env.staging.vars` in `apps\worker\wrangler.jsonc` (e.g. `EMAIL_PROVIDER` is `console`). They take effect on the next deploy.

---

## 5. Before real users

| Item | Why | How |
|---|---|---|
| **Real email** | Users must receive codes by email | Verify a domain in Resend → `wrangler secret put RESEND_API_KEY --env staging` → set `EMAIL_PROVIDER` to `resend` and `EMAIL_FROM` to an address on that domain → deploy. Without a domain Resend only delivers to its account owner. |
| **Real Turnstile keys** | Test keys always pass (no bot protection) | Cloudflare → Turnstile → add a widget for the staging hostname → site key into `TURNSTILE_SITE_KEY` (wrangler.jsonc), secret via `wrangler secret put TURNSTILE_SECRET_KEY --env staging`. |
| **Workers Paid (US$5/month)** | Free plan allows 10 ms CPU per request. Measured: typical 1 to 14 ms, sign-in ~45 ms, cold starts up to ~100 ms. Over-limit requests can be stopped under load (error 1102). | Cloudflare dashboard → Workers & Pages → Plans. No code change. |

---

## 6. How staging was created

For reference, or to rebuild it:

1. `pnpm exec wrangler login` (as jameel.outskill@gmail.com), then `pnpm exec wrangler whoami`.
2. `pnpm exec wrangler d1 create aicoach-staging`, with its `database_id` put under `env.staging` in `apps\worker\wrangler.jsonc`.
3. The first deploy printed the workers.dev address, which was set as `APP_URL` and `WEB_ORIGIN` in wrangler.jsonc.
4. Secrets `BETTER_AUTH_SECRET` and `TURNSTILE_SECRET_KEY` set with `wrangler secret put`.
5. Migrations applied and pilot data loaded (`db:seed:staging`).

**Optional later, automatic deploys:** `.github/workflows/ci.yml` can deploy staging on every push to `main` once the GitHub repo has secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and the variable `STAGING_DEPLOY_ENABLED=true`. It's **off** on purpose: staging is deployed manually at phase end.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| `pnpm deploy:staging`: "not authenticated" | `cd apps\worker` then `pnpm exec wrangler login` |
| No codes in `pnpm logs:staging` | Start the log **before** signing in; it only shows new events. Or check Cloudflare dashboard → Workers & Pages → aicoach-api-staging → Logs. |
| Error page "1102" / "Worker exceeded resource limits" | Free-plan CPU limit; retry. Persistent: move to Workers Paid ([§5](#5-before-real-users)). |
| Phone shows "Local server" while testing staging | Stop Terminal 2 and run `pnpm dev:mobile:staging`. |
| A new feature fails only on staging | Usually a missing secret ([§4](#4-secrets--config)) or a migration not applied (re-run `pnpm deploy:staging`). |
