# AI Coach — Progress

> Single source of truth for **where the build is**. Claude reads this at the start of every session and updates it at the end.
> Design lives in [architecture.md](architecture.md). Phase details and exit criteria are in §7 of that document.

## Current status

| | |
|---|---|
| **Current phase** | Phase 1: LLM gateway, model switching & credits (not started). Phase 0 ✅ complete |
| **Last updated** | 2026-11-08 |
| **Build / tests** | All green: typecheck (6 packages), 24 worker integration tests + 3 core tests (`pnpm test`), 3 Playwright browser tests (`test:e2e`), Android bundle builds |
| **Blockers** | Phase 1 needs a **rotated** OpenRouter API key (user stores it in `apps/worker/.dev.vars` and via `wrangler secret put OPENROUTER_API_KEY --env staging`) |
| **Staging** | https://aicoach-api-staging.jameel-outskill.workers.dev (live; codes via `wrangler tail --env staging`) |

Status legend: ⬜ not started · 🟡 in progress · ✅ done (exit criteria passed + user sign-off) · ⛔ blocked

## Prerequisites (user-provided)

| Item | Needed by | Status |
|---|---|---|
| Cloudflare account (jameel.outskill@gmail.com), `wrangler login` done | Phase 0 deploy | ✅ |
| GitHub remote `jameel-learner/aicoach` | Phase 0 CI | ✅ remote configured |
| Email sending: Resend account (jameel.learner@gmail.com). Without a verified domain, Resend only delivers to the account owner's address (fine for dev). **A sender domain is needed before the pilot** | Phase 0 (dev: console log) | 🟡 |
| Android phone with Expo Go (connects by QR code on the same Wi-Fi) | Phase 0 mobile shell | ✅ |
| OpenRouter API key, stored **only** in `apps/worker/.dev.vars` and `wrangler secret`. The key pasted in chat on 2026-11-08 should be **rotated** first | Phase 1 | 🟡 rotate, then store |
| NCERT Accountancy PDFs: `docs/textbooks/accountancy_1.pdf` (~204 pp), `accountancy_2.pdf` (~296 pp). Git-ignored | Phase 2 | ✅ |
| KSEAB 2nd PUC Accountancy blueprint / model papers / marking scheme | Phase 3 | ⬜ |

## Phase overview

| Phase | Name | Status |
|---|---|---|
| 0 | Foundations | ✅ |
| 1 | LLM gateway, model switching & credits | 🟡 next |
| 2 | Textbook ingestion & grounded Q&A | ⬜ |
| 3 | Board strategy & pre-generated assets | ⬜ |
| 4 | Session engine & explain/memorise journeys | ⬜ |
| 5 | Practice, assessment & time management | ⬜ |
| 6 | Test papers & mock exams | ⬜ |
| 7 | Teacher journeys & institutional layer | ⬜ |
| 8 | Engagement engine & social learning | ⬜ |
| 9 | Hardening, compliance & scale | ⬜ |

---

## Phase checklists

### Phase 0: Foundations ✅ (2026-11-08)
- [x] Monorepo scaffold (pnpm 12 workspaces, hoisted, Turborepo, TS 6 strict, Prettier, Vitest 4)
- [ ] ESLint (deferred: Prettier + strict TS cover Phase 0; add with typescript-eslint + react-hooks before Phase 2)
- [x] `apps/worker`: Hono app, wrangler config (dev + staging env; staging ids are placeholders), `/api/health`, `/api/config`
- [x] `packages/db`: Drizzle + D1 schema v1 (users, roles, institutions, class_groups, boards/classes/subjects/offerings, enrolments, parent_contacts, consents, audit_log) + migrations
- [x] Seed: KSEAB → 2nd PUC → Accountancy (`packages/db/seed/seed.sql`)
- [x] Better Auth: email+password (PBKDF2 hashing for Workers CPU limits), email-OTP 2FA on by default, no session on sign-up, Turnstile (captcha plugin), roles, DB rate limiting
- [x] `Notifier` interface + console/memory/Resend adapters
- [x] RBAC + tenant-scoping (`requireAuth`, `requireRole`, `lib/access.ts`); admin/institution/teacher/me/parent-consent APIs
- [x] `apps/admin-web`: login/sign-up/2FA with Turnstile; Admin (institutions + POCs, boards/levels/subjects/offerings, users/roles) · POC (classes, join codes, class teacher, teachers) · Teacher (my classes, students)
- [x] `apps/mobile` (Expo SDK 58): sign-in/up + Turnstile (WebView) + email code, onboarding (parent contact + consent ack → join class by code or self-study), enrolment switcher, tabs Home/Learn/Practice/Me. Typechecks and bundles; **not yet run on a device**
- [x] Design tokens (`packages/ui-tokens`, light/dark) + accessibility baseline (48dp targets, labels/roles, 16px body, focus rings)
- [x] Engagement policy checklist: [engagement-policy.md](engagement-policy.md)
- [x] CI workflow `.github/workflows/ci.yml` (format, typecheck, tests, web build). First run on GitHub passed (commit 7a104c4)
- [x] Staging deploy: D1 `aicoach-staging` (APAC), secrets set, migrated + seeded, live at https://aicoach-api-staging.jameel-outskill.workers.dev. End-to-end smoke test (sign-up → sign-in → code from cloud logs → /me) passed
- [x] CLAUDE.md *Commands* table
- [x] **Exit:** E2E sign-up → 2FA → login per role; RBAC/tenant tests; deploy works; user verified all flows locally on web + phone and asked to close Phase 0 with the cloud deploy

### Phase 1: LLM gateway, model switching & credits ⬜
- [ ] OpenRouter client via AI Gateway (streaming, `usage.cost`, generation ID, gateway cache-hit detection)
- [ ] `model_registry` + nightly sync from OpenRouter `/models`. Admin Models screen (per task, capability filter, fallback, price, eval score)
- [ ] Wallet tree + `allotments` (allot → edit while open → receiver acknowledges → giver locks) + append-only ledger
- [ ] Hold → settle metering, idempotency, reconciliation cron, stale-hold expiry
- [ ] Offline payments (credit_purchase / onboarding_fee) → issuance. POC → class. Teacher → student. Per-student daily cap
- [ ] Usage dashboards per role (self + immediate downline; Admin full tree), low-balance alerts, "Request credits"
- [ ] Platform float panel (OpenRouter balance vs outstanding credits)
- [ ] Admin LLM playground
- [ ] **Exit:** see architecture §7 Phase 1 + user sign-off

### Phase 2: Textbook ingestion & grounded Q&A ⬜
- [ ] Institution textbook onboarding (`institution_books`: select existing or upload new)
- [ ] `IngestBook` workflow (OpenRouter PDF parse → figures → structure → QA gate → chunk → embed → Vectorize + FTS5)
- [ ] Admin parse-review screen
- [ ] Retrieval (hybrid + rerank + scoping) + citation verifier
- [ ] Semantic answer cache + force-new variants (metered)
- [ ] Mobile "Ask your textbook" (streaming, tables/formulas, citation badges)
- [ ] Eval harness v1 (50+ golden Qs on NCERT Accountancy)
- [ ] **Exit:** see architecture §7 Phase 2 + user sign-off

### Phases 3–9 ⬜
Checklists are expanded from architecture §7 when the phase starts.

---

## Known issues / bugs

- Turnstile on mobile loads in a WebView with baseUrl = API URL. In staging/prod the Turnstile site key must allow that hostname. Untested on a device.
- Better Auth rate limiting is disabled in the test env, so the classroom-sized limits in `auth.ts` aren't covered by automated tests.
- Resend free tier without a verified domain only delivers to the account owner's address. Real users need a domain before the pilot. Staging currently uses EMAIL_PROVIDER=console (codes in `wrangler tail`).
- Staging uses Cloudflare's Turnstile **test** keys (no bot protection). Create a real widget before the pilot.
- Free-plan CPU: measured on staging, warm requests 1 to 14 ms, sign-in ~45 ms (PBKDF2), cold starts up to ~100 ms; limit is 10 ms. All succeeded, but move to Workers Paid (US$5/month) before real users. Phase 1 (LLM streaming) is the natural point.

## Pending confirmations

*(none. Allotment lifecycle confirmed 2026-11-08: allot → spend → receiver acknowledges → giver locks; edits only while open.)*

## Session log

### 2026-11-08
- Wrote architecture.md v2 (AI approach, stack, phases), recorded all Section 9 decisions, created CLAUDE.md and progress.md.
- Confirmed allotment lifecycle. Prerequisites recorded. Added .gitignore (textbooks + secrets excluded).
- Started Phase 0.

### 2026-11-08 (Phase 0 build)
- Built monorepo, D1 schema + migration, Better Auth (PBKDF2, email-OTP 2FA default, Turnstile, rate limits sized for school NAT), RBAC/tenant APIs, parent consent flow (GET shows / POST confirms), web app, mobile app, CI, engagement policy.
- Fixed found-by-tests bugs: email validation before trim (trailing spaces rejected); 2FA plugin default limit 3/10s per IP would block a classroom; make-admin script broke on Windows shell quoting.
- Added dev-only `/api/dev/outbox` (404 outside development) for E2E to read OTPs.
- Phone test bug (fixed): signed-out users landed on the "Enter your code" screen (router fallback picked `verify`). `verify` now redirects to sign-in unless a sign-in is in progress, and has a "Back to sign in" link; sign-up's "I already have an account" now replaces to sign-in.
- Phone test bug 2 (fixed): after the password step the app bounced back to sign-in. Root cause: Better Auth sets `isPending=true` on every session re-check while signed out, and the root layout swapped the whole <Stack> for a spinner, which discarded navigation state. The Stack now stays mounted after first boot; loading and error states are overlays (`apps/mobile/src/app/_layout.tsx`). This was also the real cause of bug 1.
- **User verified all 10 walkthrough steps on web + Android phone (all login/onboarding flows work).** Steps saved as [setup-and-deployment.md](setup-and-deployment.md).
- Committed Phase 0 (7a104c4) and pushed; first GitHub CI run passed.
- Staging deployed. Perf fix: Better Auth instance is now cached per isolate (`getAuth`) instead of rebuilt on every request (warm /api/health 2–4 ms → 0–1 ms). Missing RESEND_API_KEY no longer breaks every route (fails only on send).
- Guide updated: docs/setup-and-deployment.md §6 (using staging, deploying, what's left before the pilot).
- **Phase 0 complete.** Next: Phase 1, starting with the user rotating the OpenRouter key.
