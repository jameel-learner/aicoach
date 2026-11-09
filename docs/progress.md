# AI Coach — Progress

> Single source of truth for **where the build is**. Claude reads this at the start of every session and updates it at the end.
> Design lives in [architecture.md](architecture.md). Phase details and exit criteria are in §7 of that document.

## Current status

| | |
|---|---|
| **Current phase** | Phase 2: Textbook ingestion & grounded Q&A: **signed off on LOCAL by the user 2026-11-09**, committed; staging deploy + test ([staging.md §3c](environments/staging.md#3c-phase-2-on-staging-textbooks--ask)) is the last step. Phase 3 starts after that |
| **Last updated** | 2026-11-09 |
| **Build / tests** | All green: typecheck, lint, 54 worker + 8 core tests (`pnpm test`), 4 Playwright browser tests (`test:e2e`; test data removed afterwards), web build, Android bundle builds |
| **Blockers** | None |
| **Staging** | https://aicoach-api-staging.jameel-outskill.workers.dev (live with Phase 1, commit `4a2509b`; Phase 2 deploy pending, see staging.md §3c; codes via `pnpm logs:staging`) |

Status legend: ⬜ not started · 🟡 in progress · ✅ done (exit criteria passed + user sign-off) · ⛔ blocked

## Prerequisites (user-provided)

| Item | Needed by | Status |
|---|---|---|
| Cloudflare account (jameel.outskill@gmail.com), `wrangler login` done | Phase 0 deploy | ✅ |
| GitHub remote `jameel-learner/aicoach` | Phase 0 CI | ✅ remote configured |
| Email sending: Resend account (jameel.learner@gmail.com). Without a verified domain, Resend only delivers to the account owner's address (fine for dev). **A sender domain is needed before the pilot** | Phase 0 (dev: console log) | 🟡 |
| Android phone with Expo Go (connects by QR code on the same Wi-Fi) | Phase 0 mobile shell | ✅ |
| OpenRouter API key: stored in `apps/worker/.dev.vars` (local). The user chose to keep the key shared in chat (not rotated). Same key set as staging secret on 2026-11-09 | Phase 1 | ✅ local · ✅ staging |
| NCERT Accountancy PDFs: `docs/textbooks/accountancy_1.pdf` (~204 pp), `accountancy_2.pdf` (~296 pp). Git-ignored | Phase 2 | ✅ |
| KSEAB 2nd PUC Accountancy blueprint / model papers / marking scheme: `docs/textbooks/30_ACCOUNTANCY_BP.pdf` + `30_ACCOUNTANCY_MQP_1..5.pdf` (also BP for Economics, Business Studies, Computer Science; MQP for Economics). Marking scheme not seen yet | Phase 3 | 🟡 blueprint + model papers present |

## Phase overview

| Phase | Name | Status |
|---|---|---|
| 0 | Foundations | ✅ |
| 1 | LLM gateway, model switching & credits | ✅ (2026-11-09) |
| 2 | Textbook ingestion & grounded Q&A | 🟡 |
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

### Phase 1: LLM gateway, model switching & credits ✅ (2026-11-09)
Commits `c3a51f9` (phase) + `4a2509b` (class-teacher reassignment). Backend: **16 credits tests** (`test/credits.test.ts`, OpenRouter mocked in `test/openrouter-mock.ts`).
- [x] Migration `0001_phase1_llm_credits.sql`: llm_models, model_registry, platform_settings, wallets (CHECK balance ≥ held ≥ 0), payments, allotments, allotment_edits, ledger_entries, credit_holds, llm_usage, credit_requests
- [x] Money: wallets in **micro-INR** integers (1 credit = ₹1 = 1e6 micro), provider cost in nano-USD, converted at the Admin-set USD→INR rate (default ₹88.00, stored per usage row). Helpers + tests in `packages/core/src/money.ts` (decision 9.3-2; replaced the earlier nano-USD wallets)
- [x] OpenRouter client (`src/llm/openrouter.ts`): `usage.cost`, generation id, fallback `models`, AI Gateway via optional `AI_GATEWAY_URL`, cache-hit (`cf-aig-cache-status: HIT`) charged 0
- [x] Model registry (`src/llm/registry.ts`): per-task model + fallbacks, capability check, 30 s cache (switch without redeploy), sync from OpenRouter `/models`. The 4 decision-7 models are selectable by default; slugs verified live: `google/gemini-2.5-flash`, `anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-5.5`, `openai/gpt-4o-mini`
- [x] Single metered path `runMeteredChat` (`src/llm/run.ts`): estimate (worst case over fallbacks) → hold (spend order) → call → settle actual × (1 + fee) / release on error
- [x] Wallet tree + lazy creation (`src/credits/wallets.ts`), allot/edit/ack/lock (`src/credits/ledger.ts`), hold/settle/expiry (`src/credits/meter.ts`), per-role reports (`src/credits/reports.ts`)
- [x] APIs: `/api/credits/*` (mine, wallet view, allotments, ack, lock, daily cap, request credits), `/api/admin/credits/*` (payments, issue, fee, float, top-level), `/api/admin/models/*` (list, sync, catalog, selectable, registry), `/api/ai/playground` (admin → platform wallet; teacher → class wallet then own)
- [x] Crons: hourly stale-hold expiry, nightly model/price sync (wrangler.jsonc triggers)
- [x] Email notices: credits received/corrected (to receiver), credit request (to giver)
- [x] Web UI: Credits home + wallet page (all roles; downline, give, daily cap, allotments with confirm/correct/lock, usage), Admin Credits & payments (float, fee, record payment, issue, top-level wallets, payments list), Admin AI models (sync, per-feature model + fallback, add/remove models), AI playground (Admin; Teacher with class choice)
- [x] Mobile: Me → My credits (balance in ₹, used 30 days, Confirm received, Request credits / "I have paid" with UTR, replies with comments)
- [x] Change of class teacher (decision 9.3-4): Admin/POC reassign; the class's unused balance returns to the institution; teacher's own and students' credits untouched
- [x] Local test-data clean-up (`pnpm cleanup-test:local`, also Playwright teardown); E2E refuses non-development servers
- [x] Walkthrough feedback (decision 9.3): credit requests with **accept/reject + comment** (`src/credits/requests.ts`, `/api/credits/requests`), requests to Admin need the **UTR** and create a **pending payment** that Admin confirms (credits issued automatically) or rejects; inboxes on web Credits page (teacher/POC) and Admin *Payments to verify*; **everything in ₹** (OpenRouter float in US$ with ₹ equivalent); **fee hidden** from everyone but Admin
- [x] **Exit criteria** (architecture §7 Phase 1), evidence in `apps/worker/test/credits.test.ts` + `e2e/credits.spec.ts`:
  - [x] 50 concurrent calls on one wallet never overspend; `issued = Σ balances + Σ billed`; every wallet balance = Σ its ledger entries
  - [x] Lock requires acknowledgement; an edit clears it; a locked allotment rejects every change
  - [x] Billing exact in integers (now: USD cost × rate × 1.10, rounded half-up; platform wallet at cost)
  - [x] Gateway cache hit charged 0
  - [x] Visibility: each role sees own + immediate downline only; Admin sees all
  - [x] Model switch takes effect without a redeploy (30 s registry cache)
  - [→] *Streaming* and *reconciliation vs OpenRouter < 0.5%*: **moved to Phase 2** with the user's sign-off (non-streamed calls are settled from OpenRouter's own `usage.cost`, so there is nothing to reconcile until streams can be aborted)
  - [x] User sign-off after local + staging walkthroughs (2026-11-09)
- **Deferred to Phase 2:** streaming responses; generation-endpoint reconciliation cron; eval scores on the Models screen. **Deferred (no phase yet):** usage roll-up table (live aggregates are fast enough at pilot scale); low-balance alert emails.
- **Staging (done 2026-11-09):** `OPENROUTER_API_KEY` secret set; `pnpm deploy:staging` applied migration 0001; models synced; user walked through the 13-step credits & AI flow on staging.

### Phase 2: Textbook ingestion & grounded Q&A ✅ on LOCAL (user sign-off 2026-11-09; staging test pending)
Pilot book: NCERT Accountancy Class 12, Parts I & II (`docs/textbooks/accountancy_1.pdf`, `accountancy_2.pdf`).

**Carried over / housekeeping**
- [x] ESLint 10 flat config at root (`eslint.config.mjs`: typescript-eslint, react-hooks), `pnpm lint` (max 0 warnings), added to CI. Fixed: untyped OpenRouter response (`any`), enrolment context re-rendering every consumer (unmemoised `[]`)
- [x] Streaming in `runMeteredChat` (`onDelta`; OpenRouter SSE read to the end, cost from the final chunk). `/api/ask` streams SSE and settles via `waitUntil` even if the client disconnects
- [x] Reconciliation (hourly cron, `src/credits/reconcile.ts`): OpenRouter `/generation` cost vs charged, `adjust` ledger entries at the call's own rate + fee; float panel shows the 30-day difference %. Exit check (< 0.5%) after real usage

**Ingestion**
- [x] Shared content store created (decision 9.4-1): Vectorize `aicoach-content-chunks` (1024 dims, cosine, metadata index `book`), R2 `aicoach-content`; bindings `CONTENT_VECTORS`, `CONTENT`, `AI` in wrangler.jsonc (LOCAL `remote: true`, staging same names). Tests run with `remoteBindings: false`
- [x] Parse trial (5 pages of accountancy_1, pages split out with `pdf-lib`, OpenRouter `file-parser` plugin; parsed text returned in `choices[0].message.annotations[].file.content`): **mistral-ocr** keeps balance-sheet tables as Markdown tables and headings, ~US$0.0022/page, ~2.2 s/page; **cloudflare-ai** (free) flattens tables and glues numbers together (unusable for Accountancy). → Use mistral-ocr; both books (500 pages) ≈ **US$1.10 (≈ ₹97)**, one time
- [x] Migration `0002_phase2_books`: `books`, `book_pages`, `chunks`, `institution_books` + hand-written FTS5 `chunks_fts`
- [x] LLM path: OpenRouter `plugins` + parsed text from file annotations (`fileText`), hold covers the per-page OCR fee (`extraEstimateUsdNano`)
- [x] `src/content/`: `store.ts` (shared R2/Vectorize/embeddings; in-memory fakes in tests), `chunk.ts` (page-bound chunks, tables kept whole, running headers dropped, quality flags), `ingest.ts` (split → parse → publish as named steps), `import.ts`, `workflow.ts` (`IngestBookWorkflow`, binding `INGEST_BOOK`, LOCAL only)
- [x] Book packages in R2 (`books/<id>/<version>/manifest.json, pages.jsonl, chunks.jsonl` + `catalog/<id>.json`); versions are new ids in Vectorize (append-only)
- [x] Admin API `/api/admin/books` (upload, parse, publish, page view/PDF/edit/approve/re-parse, shared list + import, institution mapping)
- [x] Admin web: *Textbooks* (upload, progress, shared-store import) and book review (page grid with flags, PDF page beside its text, edit/approve/re-read, publish, institutions)
- [x] Tests: `test/content.test.ts` (chunking, flags, full upload → parse → review → publish v1/v2 → import elsewhere, credit stop, admin-only)
- [x] Figure descriptions: pages whose OCR text has image placeholders get a second call (task `figure_description`, platform wallet) and the placeholders are replaced by "**Figure:** …" text
- [ ] Chapter list (structure) beyond per-chunk section headings: not needed for Q&A; revisit in Phase 3 (notes per chapter)
- [ ] Real run on LOCAL: NCERT Part I and II through the UI (≈ US$1.10), spot-check review

**Q&A**
- [x] Scope (`src/content/scope.ts`): student → institution's mapped books for the enrolment's subject (fallback: all published for the subject), pays class wallet then own; teacher → class books, class wallet then own; POC → institution books + wallet; Admin → all, platform wallet
- [x] Retrieval (`src/content/retrieve.ts`): Vectorize (shared) + FTS5 (local), reciprocal-rank fusion, Workers AI `bge-reranker-base`, top 6 sources
- [x] Answering (`src/content/answer.ts`, prompt `tutor_answer@1` in `src/llm/prompts.ts`): answer-first, excerpts only, `[S#]` citations, `NOT_IN_TEXTBOOK:` marker (never shown), citation verifier (unknown sources dropped, weak support flagged → "uncertain")
- [x] Answer cache (`answers` table, migration 0003): same scope + same/similar question (bge-m3 cosine ≥ 0.92) → stored answer, free; "Get a new answer" → new variant (charged)
- [x] API `/api/ask` (SSE: meta → delta* → done | error; `stream:false` JSON) and `/api/ask/scope`
- [x] Web: floating **Ask your textbook** button on every signed-in page → right-hand drawer over the page, expandable, streamed Markdown with tables, page badges with source snippet, ⚠ not-in-book / uncertain notes, "Get a new answer", class picker for teachers
- [x] Mobile: Learn tab is now "Ask your textbook" (`expo/fetch` streaming, own Markdown renderer with tables + page badges, same flags). Formulas are plain text by prompt design (no KaTeX on the phone)
- [x] Tests: `test/ask.test.ts` (streamed cited answer + charge, cache hit free, force-new variant, not-in-book, uncertain, credit error event, role scoping, reconciliation adjust + ledger invariant, citation verifier, eval endpoints)

**Enrolments**
- [x] Admin can remove a learner from a class / self-study subject (decision 9.4-2; Admin → Users → *Classes & subjects*); re-joining reactivates; test in `credits.test.ts`

**Evaluation**
- [x] Eval harness v1: `evals/golden/ncert-accountancy.jsonl` (55 questions with expected pages + reference answers from the PDFs: 21 Part I, 31 Part II, 3 off-syllabus), `evals/run.mjs` (LOCAL, Admin sign-in, fresh answers, optional `--model`), judge endpoint (task `eval_judge`), runs stored (`eval_runs`) and shown on Admin → AI models
- [ ] Run the evals after the real ingestion; add journal-entry / table / figure questions once the parsed pages are reviewed

- [x] **Exit (measured on LOCAL 2026-11-09; user accepted the phase with the gaps below):**
  - Reconciliation: 291 real calls checked against OpenRouter `/generation`: **0.0% difference** (target < 0.5%) ✅
  - Cache hit: **28–34 ms** (target < 300 ms) ✅, after making exact matches skip the question embedding (was 176–405 ms)
  - Force-new creates a variant ✅ (tests + walkthrough); streaming ✅ (web + phone)
  - Golden set, Part I + not-in-book (24 questions, gpt-4o-mini): **correctness 91.7%** ✅, **citation 87.5%** (target 90%; ≈ 92% with the corrected p1-16 item, not re-run yet)
  - Tables parse as Markdown tables ✅ (mistral-ocr; reviewed by the user). Parsing "fixtures" were replaced by the real-book review
  - User sign-off on LOCAL ✅ (2026-11-09)
- **Carried into Phase 3 (accepted by the user):** upload + publish **Part II** on LOCAL (then *Import* it on staging) and re-run the evals on both books with the registry model; the two real citation misses (p1-15, p1-18); LaTeX in parsed pages (`$\frac{1}{5}$`) isn't rendered on web/phone; add journal-entry / table / figure golden questions
- **Phase-end staging steps (final, see [staging.md §3c](environments/staging.md#3c-phase-2-on-staging-textbooks--ask)):** no new secrets and no new Cloudflare resources (the shared Vectorize index + R2 bucket and Workers AI are already bound under `env.staging`). **No Workflow on staging on purpose:** books are processed only on LOCAL; staging refuses uploads with "Process books on local, then import them here." (user request; the upload card shows that text instead of the form), so no unprocessable PDF reaches the shared store `pnpm deploy:staging` applies migrations 0002 + 0003; then Admin → Textbooks → **Import** (free, no OpenRouter calls), map the staging institution, try Ask on web + phone. Workers Paid only if the import or Ask hits error 1102 (CPU limit)

### Phases 3–9 ⬜
Checklists are expanded from architecture §7 when the phase starts.

---

## Known issues / bugs

- Turnstile on mobile loads in a WebView with baseUrl = API URL. In staging/prod the Turnstile site key must allow that hostname. Untested on a device.
- Better Auth rate limiting is disabled in the test env, so the classroom-sized limits in `auth.ts` aren't covered by automated tests.
- Resend free tier without a verified domain only delivers to the account owner's address. Real users need a domain before the pilot. Staging currently uses EMAIL_PROVIDER=console (codes in `wrangler tail`).
- Staging uses Cloudflare's Turnstile **test** keys (no bot protection). Create a real widget before the pilot.
- Free-plan CPU: measured on staging, warm requests 1 to 14 ms, sign-in ~45 ms (PBKDF2), cold starts up to ~100 ms; limit is 10 ms. All succeeded, but move to Workers Paid (US$5/month) before real users. Phase 2 (streaming + ingestion) is the natural point.
- Low-balance alert emails (architecture §6.6 views) not built yet; balances and requests cover the pilot flow.
- Parsed pages keep formulas as LaTeX (`$\frac{1}{5}$`). The web drawer and phone show answers as Markdown without a LaTeX renderer, so a copied formula appears raw. Phase 3: render it (KaTeX on web; plain-text conversion or a renderer on the phone).
- Only NCERT Accountancy **Part I** is processed. Part II questions answer "not in your textbook" until it is uploaded and published on LOCAL (and imported on staging).
- Scheduled jobs don't run by themselves under `wrangler dev`: trigger the hourly job (holds + reconciliation) with `curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=0+*+*+*+*"`.

## Pending confirmations

- *(Resolved 2026-11-09, decision 9.4-1: one shared content store for LOCAL + STAGING.)*
- *(Resolved 2026-11-09: ingestion cost measured (≈ US$0.0022/page, mistral-ocr) and approved by the user; Part I cost ≈ US$0.46.)*
- **Workers Paid (US$5/month):** not needed for the Phase 2 staging test (no ingestion on staging; streaming waits on the network, not CPU). Upgrade if staging shows error 1102, and before real users.
- *(Resolved: allotment lifecycle confirmed 2026-11-08.)*

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

### 2026-11-08 (Phase 1, part 1: backend)
- User kept the existing OpenRouter key; stored in `apps/worker/.dev.vars` only.
- Verified live against OpenRouter: model slugs + prices, `usage.cost` in normal and streamed responses, `/credits` balance ($10 total, $2.76 used).
- Built migration 0001, money helpers (nano-USD), OpenRouter client, registry, metering, ledger, reports, APIs, crons. 37 worker tests pass (incl. 50 concurrent calls never overspend, exact 10% fee, ledger invariant, visibility per role, model switching).
- Fixed found-by-tests: refusal message now explains the first-choice wallet's reason (e.g. daily cap) instead of the fallback wallet's.
- Next: web + mobile UI for credits, models and playground; then local walkthrough with the user.

### 2026-11-08 (Phase 1, part 2: UI + real end-to-end)
- Built web UI (credits, admin credits/payments, models, playground) and mobile My credits card.
- Real smoke test on LOCAL against real OpenRouter: 425 models synced; admin call billed = raw (no fee); teacher call raw $0.0000544 → billed $0.00005984 (exactly ×1.10); model switch to gpt-4o-mini took effect; float read real balance ($7.24). Total spend ≈ $0.00007.
- Bugs found and fixed: (1) named exports from the worker entry broke workerd startup (moved crons to `src/cron.ts`, added `test/entry.test.ts`); (2) model sync used `NOT IN (425 ids)`, over D1's 100-parameter limit (now timestamp-based; mock returns 150 filler models); (3) web `Field` wrapped controls in `<label>`, so a select's accessible name included its selected option (now label + htmlFor).
- Added `e2e/credits.spec.ts` (payment → issue → POC confirm → give → teacher sees; playground real call).
- Local walkthrough for the user: docs/environments/local.md §3b.
- Not committed yet (phase-wise commit after sign-off).

### 2026-11-08 (Phase 1, part 3: walkthrough feedback)
- User feedback after the local walkthrough → decisions 9.3-1..3 (architecture §6.6 + §9.3 updated first):
  - Credit requests now appear on the giver's web Credits page; the giver **accepts** (automatic allotment, amount editable) or **rejects with a comment**; the requester sees status + comment (web and phone). One pending request per wallet; requester can cancel.
  - Requests that go to **Admin** (institution wallet, direct teacher/student wallet) must carry the **payment UTR**. They create a `pending` payment; Admin's *Payments to verify* confirms (payment → verified, credits issued in the same flow) or rejects (payment → rejected, UTR can be resubmitted). Duplicate UTRs are refused. Manual issue against a pending payment is refused.
  - **All amounts in ₹** (1 credit = ₹1). Wallet money is now micro-INR; OpenRouter cost stays nano-USD and is converted at an Admin-set USD→INR rate (default ₹88.00, `PUT /api/admin/credits/rate`), stored per usage row. The platform float shows US$ with ₹ equivalent.
  - **Fee hidden**: removed "1 credit = US$1" and "+10% fee" wording everywhere outside Admin (web + phone). E2E asserts a teacher's Credits page shows no "US$", "10%" or "fee".
- Schema: migration 0001 regenerated (it was never applied to staging): `*_micro` columns, `payments.status/verified_by/verified_at`, `llm_usage.raw_usd_nano/usd_inr_paise`, `credit_requests` redesigned. Local DB: Phase 1 tables dropped and 0001 re-applied (Phase 0 accounts kept; backup in the session scratchpad).
- Fixed along the way: Admin Credits page reset the issue form from stale state after a request finished (now functional state updates); E2E sign-in helper could reuse an old OTP on a second sign-in.
- Tests: 40 worker (2 new: student→teacher accept/reject; UTR → pending payment → Admin confirm/reject), 8 core (INR conversion incl. BigInt for large values), 4 E2E (credits flow now includes teacher request → POC accepts), Android bundle OK.
- Seed check (user asked): `packages/db/seed/seed.sql` (also used for staging) holds only board/level/subject reference data, with no colleges, wallets or credits; now documented in the file. The "Credit E2E College …" rows with 100 are created by `e2e/credits.spec.ts` on LOCAL and are ₹100 (micro-INR). The E2E now refuses to run unless `/api/health` reports `development`, and asserts the issued amount shows as ₹100.00; the worker test asserts 100 = 100,000,000 micro-INR.
- 2026-11-09: **Teacher buys own credits** from Admin with a UTR (web: *My own credits* card → *Buy credits*; phone: Me → *I have paid*). The API already supported it; the web entry point is now visible and the E2E covers teacher pays → Admin confirms → ₹200 on the teacher's own wallet.
- 2026-11-09: **Test-data cleanup**: `apps/worker/scripts/cleanup-test-data.mjs` (`pnpm cleanup-test:local`, LOCAL only) removes `@example.com` accounts and "Credit E2E College / E2E PU College / Smoke College <n>" institutions with all their classes, wallets, payments, allotments, ledger, usage and requests, then recomputes the platform wallet from its ledger. Runs automatically as Playwright `globalTeardown`. Run once on the user's local DB: only Shaheen PU College and the user's 4 accounts remain; every wallet balance equals its ledger sum.
- Next: user re-tests on LOCAL (local.md §3b, updated), then commit + staging + sign-off.
- 2026-11-09: **Change of class teacher** (user request, decision 9.3-4, architecture §6.6): Admin/POC can reassign a class (web: *Change* → *Reassign* on the institution page). In one batch: the class wallet's unused balance returns to the institution (locked allotment class → institution, visible in both histories), the old teacher's teacher-enrolment ends, their pending requests for the class are cancelled. Students' and the teacher's own credits are untouched. `returnToParent` in `src/credits/ledger.ts`. Tests: worker 41 (new reassignment test incl. ledger invariant), E2E credits flow ends with a reassignment (₹33 returned). Not yet committed/deployed: commit + `pnpm deploy:staging` again before the staging walkthrough.
- 2026-11-09: User approved the local tests. Phase 1 committed (`c3a51f9`) and pushed; staging secret `OPENROUTER_API_KEY` set (piped from `.dev.vars`, never printed). staging.md got a Phase 1 section (§3a) and the reasoning for keeping E2E local-only (§3b). Next: user runs `pnpm deploy:staging` (migration 0001), walks through §3a step 4, signs off.

### 2026-11-09 (Phase 1 sign-off)
- User tested Phase 1 on LOCAL and STAGING (13-step credits & AI walkthrough incl. class-teacher reassignment) and signed off. **Phase 1 complete.**
- Exit criteria recorded above; streaming and OpenRouter reconciliation moved to Phase 2 with sign-off.
- Docs closed out: progress.md (Phase 1 ✅, Phase 2 checklist + planned staging steps + pending confirmations), architecture §7 (Phase 1 status, carried items in Phase 2), staging.md (live version), CLAUDE.md (repository map: real vs planned folders).
- Next: Phase 2. First steps: ESLint, then schema + R2 upload + ingestion of a few pages to measure cost, once the Vectorize dev-index question is answered.

### 2026-11-09 (Phase 2 start: shared content store)
- User decision 9.4-1: one **shared** Vectorize + R2 for LOCAL and STAGING so each PDF is processed once. Recorded in architecture §3.3 + §9.4, CLAUDE.md (exception to the environment rule), setup-and-deployment.md, memory.
- Created on Cloudflare: Vectorize `aicoach-content-chunks` (1024 dims, cosine; metadata index `book`), R2 bucket `aicoach-content`. Embeddings model chosen: `@cf/baai/bge-m3` (multilingual); reranker `@cf/baai/bge-reranker-base`.
- Bindings added (`CONTENT_VECTORS`, `CONTENT`, `AI`); typecheck + 41 worker tests green. Not committed (mid-phase).
- Next: ESLint, then Phase 2 schema + R2 upload + 5-page parse to measure cost.
- ESLint added and clean; CI runs it. Parse trial done (see Phase 2 checklist): mistral-ocr chosen, full NCERT run ≈ US$1.10 one time. Trial cost US$0.012.
- Built ingestion (schema 0002, shared-store layer, chunker, parse/publish/import steps, Workflow, Admin API + screens). 44 worker tests green, lint clean. Not committed (mid-phase).

### 2026-11-09 (Phase 2, part 3: Q&A, drawer, phone, evals)
- Built streaming + reconciliation, scoping, hybrid retrieval + rerank, grounded answers with citation verifier, answer cache + force-new, `/api/ask` (SSE), web drawer (user request), phone Learn tab, figure descriptions, eval harness (55 golden questions) + Models screen scores. Migration 0003 (`answers`, `eval_runs`, `llm_usage.reconciled_*`).
- Checks: 52 worker + 8 core tests, lint, typecheck, 4 E2E, Android bundle: all green. Not committed (mid-phase).
- Waiting on the user: real ingestion of both NCERT books (local.md §3c), then try Ask on web + phone and run `node evals/run.mjs`.
- Bug found in the user's first real upload (204-page Part I): `POST /api/admin/books` inserted 50 page rows per statement = 200 bound parameters → D1 "too many SQL variables" (limit 100), leaving a book row with no pages. Fixed: 20 rows per insert, and the book row + page rows go in one atomic `db.batch`. Regression test uploads a 296-page PDF. Orphan row removed from the local D1 (its original.pdf stays in the shared R2, per the add-only rule).
- Bug found by the user in local.md §3c step 9 (web drawer): "l is not a function" after asking. Cause: `useEffect(() => bottom.current?.scrollIntoView(...))` returned scrollIntoView's value (a Promise in current Chrome) as the effect cleanup; React then called it. Fixed with a block body (same pattern tidied in BookPage). Reproduced and verified with a throwaway Playwright run against the LOCAL server (test account removed by the cleanup).
- User walkthrough: student with a class + a self-study enrolment got "Join a class or choose a subject first" on the phone, though both enrolments are active and the server answers correctly for both (reproduced with a test student). Most likely the phone sent a remembered enrolment id that isn't the student's (the same phone was signed in as a teacher before). Server now falls back to the student's first subject and logs `ask scope: enrolment … is not an active enrolment` in the worker terminal. If it recurs without that log line, investigate the phone side.
- Added Admin removal of enrolments (decision 9.4-2) on request; 54 worker tests green, lint/format/web build green.
- First real eval run (user, `--model openai/gpt-4o-mini`, Part I only published): reported 5.5% citation / 40% correctness, but both numbers were wrong because of the runner: (1) it identified books by "Part I/II" in the title, and the uploaded title says "Part 1", so every citation counted as the wrong book; (2) the 31 Part II questions were scored although Part II isn't uploaded yet. Fixed `evals/run.mjs` (accepts Part 1/I, 2/II; skips questions for unpublished books and says so). Re-scored from the saved results (no new calls): **Part I + not-in-book, 24 questions: citation 87.5%, correctness 91.7%**. Golden p1-16 (hidden goodwill) widened to both book sections (p.84 admission, p.128 retirement). Real misses left: p1-15 (cites p.63, not p.60), p1-18 (cites p.117, definition is on p.59). The wrong 5.5% run stays in `eval_runs` on the Models screen (history); the next run supersedes it.
- Observation to check: parsed pages contain LaTeX (`$\frac{1}{5}$`); the web drawer and phone don't render LaTeX, so answers that copy it would show raw `$…$`.

### 2026-11-09 (Phase 2 close on LOCAL)
- User: "good to move ahead to next phase; commit and update documentation to cover staging". Measured the exit checks first: reconciliation over 291 real local calls 0.0% (hourly job triggered by hand); cache hit 176–405 ms → fixed (exact match no longer embeds the question; now 28–34 ms); eval figures as above. Gaps accepted and carried into Phase 3 (Part II, 2 citation misses, LaTeX rendering).
- Staging plan finalised (staging.md §3c): no Workflow and no new secrets on staging; deploy, then Import the books from the shared store.
- Committed Phase 2. Next: user runs staging.md §3c (deploy, import, test), then Phase 3.
- User request: staging's upload refuses PDFs ("Process books on local, then import them here."). Server check `processingEnabled` (Workflow bound or test) in `routes/books.ts` + `GET /api/admin/books/settings`; web hides the upload form. 55 worker tests green.
