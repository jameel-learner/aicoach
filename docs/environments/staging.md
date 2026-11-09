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
| Live since | 2026-11-08 (Phase 0) · Phase 1 deployed and signed off 2026-11-09 (commit `4a2509b`) · Phase 2: deploy + test pending ([§3c](#3c-phase-2-on-staging-textbooks--ask)) |
| Textbooks (from Phase 2) | **Shared with local**: Vectorize `aicoach-content-chunks` + R2 `aicoach-content`. Books are **processed on local only**; staging **imports** them (free) |

Contents: [1. End-of-phase checklist](#1-end-of-phase-checklist) · [2. Deploy](#2-deploy) · [3. Test on staging](#3-test-on-staging) · [3a. Phase 1 on staging](#3a-phase-1-on-staging-credits--ai) · [3b. Why automated browser tests don't run on staging](#3b-why-automated-browser-tests-dont-run-on-staging) · [3c. Phase 2 on staging](#3c-phase-2-on-staging-textbooks--ask) · [4. Secrets & config](#4-secrets--config) · [5. Before real users](#5-before-real-users) · [6. How staging was created](#6-how-staging-was-created) · [7. Troubleshooting](#7-troubleshooting)

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

## 3a. Phase 1 on staging (credits & AI)

Do these once, in order. Steps 1 to 3 are one-time setup for Phase 1; step 4 is the test.

**1. Code committed and pushed, CI green** (Claude does this when you say so).

**2. Set the OpenRouter key on staging** (same key as in your local `apps\worker\.dev.vars`; paste it when asked):

```powershell
cd E:\repository\aicoach\apps\worker
pnpm exec wrangler secret put OPENROUTER_API_KEY --env staging
pnpm exec wrangler secret list --env staging   # should list BETTER_AUTH_SECRET, OPENROUTER_API_KEY, TURNSTILE_SECRET_KEY
```

**3. Deploy** (applies migration `0001_phase1_llm_credits` to the staging database and registers the two cron jobs: hourly hold clean-up, nightly model/price sync):

```powershell
cd E:\repository\aicoach
pnpm deploy:staging
```

Answer **y** when it asks to apply the migration. Your Phase 0 staging accounts, institution and classes are kept; the new credit tables start empty.

**4. Test.** Keep `pnpm logs:staging` running in Terminal 1 (sign-in codes **and** the credit emails, such as requests, decisions and "credits received", appear there). Then follow the **13 steps of the [local Credits & AI walkthrough](local.md#3b-credits--ai-walkthrough-phase-1)** on https://aicoach-api-staging.jameel-outskill.workers.dev, with these differences:

| Local walkthrough says | On staging |
|---|---|
| "see Terminal 1" for emails | `pnpm logs:staging` output |
| Accounts from the local 10 steps | Your **staging** accounts from Phase 0 (POC, teacher, student already exist there) |
| Phone: `pnpm dev:mobile` | `pnpm dev:mobile:staging` (app shows "STAGING server") |
| Step 1: Sync models | Must be done first on staging, otherwise the model lists are empty and the playground uses estimated prices |
| Step 2: Platform wallet | Issue yourself a small amount (e.g. ₹50) **To: Platform wallet** before using the playground |
| UTRs | Use made-up test UTRs (e.g. `999900000001`); each UTR can be used only once |

Staging AI calls cost real OpenRouter credit (the whole walkthrough is well under ₹1). The *Platform float* shows the live OpenRouter balance, shared with local.

**5. Sign off:** tell Claude Phase 1 works on staging. Claude records it in progress.md and starts Phase 2.

**If something fails only on staging:** check `pnpm logs:staging` for the error, and the secrets list. "AI is not configured (OPENROUTER_API_KEY missing)" means step 2 was skipped. An error about a missing table means the migration didn't apply; re-run `pnpm deploy:staging`.

---

## 3c. Phase 2 on staging (textbooks & Ask)

Do these once, in order. No new secrets are needed.

**1. Code committed and pushed, CI green** (Claude does this when you say so).

**2. Book published on local.** Staging can only import books that are **published on local** (they live in the shared content store). Part I is published; Part II can be imported later in the same way, without a new deploy.

**3. Deploy** (applies migrations `0002_phase2_books` and `0003_phase2_answers` to the staging database):

```powershell
cd E:\repository\aicoach
pnpm deploy:staging
```

Answer **y** when it asks to apply the migrations. The start-up list must show `CONTENT_VECTORS`, `CONTENT` and `AI`. There is deliberately **no** `INGEST_BOOK` workflow on staging: books are processed on local only.

**4. Test.** Keep `pnpm logs:staging` running in Terminal 1 for sign-in codes. On https://aicoach-api-staging.jameel-outskill.workers.dev:

1. **Admin → Textbooks → Shared content store:** the local book is listed as *Not imported* → **Import**. It takes a few seconds and costs nothing (no OpenRouter calls; the chunks and vectors already exist). The book shows *Published v1 · imported from the shared store*.
2. Open the book → **Institutions using this book:** tick your **staging** institution → **Save**.
3. Check that processing is blocked: on the imported book there is no *Read all pages*; uploading a new PDF and pressing *Read all pages* says *processing is not enabled in this environment*. That's correct.
4. **Platform wallet:** if it is empty, issue a small amount (e.g. ₹20) **To: Platform wallet** (Admin's questions are paid from it).
5. **Ask (web):** any page → **Ask your textbook** → *What is goodwill?* The answer streams in with page badges. Ask it again: *Saved answer · free*. Try *Who won the 2011 World Cup?*: *Not in your textbook*. **Expand** widens the drawer.
6. **Ask (phone):** `pnpm dev:mobile:staging` in Terminal 2, sign in as the staging **student** → **Learn** tab → ask a question. It is charged to the student's class wallet (then their own), so the student needs credits from Phase 1 (or give some from the teacher first).
7. **Remove an enrolment:** Admin → **Users** → the student → **Show** under *Classes & subjects* (optional; re-join with the class code afterwards).
8. **Admin → Credits & payments:** the *Platform float* shows the answers' cost. *Charged vs OpenRouter* fills in after the hourly job has run.

The staging answer cache is separate from local, so the first answers on staging are fresh (charged) ones. The whole test costs well under ₹1.

**5. Sign off:** tell Claude Phase 2 works on staging. Claude records it in progress.md and starts Phase 3.

**If something fails only on staging:** check `pnpm logs:staging`. "no such table: books" (or `answers`) means the migrations didn't apply; re-run `pnpm deploy:staging`. Error **1102** during Import or Ask is the free plan's CPU limit: retry, and if it keeps happening move to Workers Paid ([§5](#5-before-real-users)).

---

## 3b. Why automated browser tests don't run on staging

The Playwright tests (`test:e2e`) refuse to run unless the server says it is `development`. That's deliberate:

1. **They need a back door that staging must not have.** The tests read sign-in codes from `/api/dev/outbox`, which lists recent emails. Locally that's a convenience; on a public URL it would let anyone read anyone's sign-in code and log in as them. So it only exists in development, and the tests can't sign in on staging.
2. **They promote users to Admin directly in the database** (`make-admin --local`). Doing that against the staging database from a test run means automated writes with full Admin rights to a shared cloud database.
3. **They leave data behind.** Each run creates accounts, a college, payments, credits and allotments. Locally a clean-up script deletes them by name pattern afterwards. Pattern-deleting rows in a cloud database is the kind of mistake that can remove real data, so the clean-up is LOCAL-only as well.
4. **Staging tests something different.** The automated tests already prove the behaviour on exactly the same code, locally. What only staging can show is the deployed setup: secrets, migrations, cron jobs, the phone over mobile data, real OpenRouter from Cloudflare. A person walking through it checks that best. Later, with real users on production, we can add a read-only smoke check (health, sign-in page loads, no writes) that is safe to run against a deployed environment.

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
| `OPENROUTER_API_KEY` | ✅ set 2026-11-09 (same key as local, per user) | Phase 1 |
| *(none new)* | Phase 2 uses bindings, not secrets: Vectorize, R2 and Workers AI are in `env.staging` of `wrangler.jsonc` | Phase 2 |
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
| Textbooks: *Shared content store* is empty | The book isn't **published** on local yet (publish it there first), or the deploy didn't happen. |
| Textbooks: "processing is not enabled in this environment" | Expected: books are processed on local only. Use **Import** under *Shared content store*. |
| Ask: "No textbook is set up for you yet" | Import the book on staging, and tick the staging institution under *Institutions using this book*. |
