# CLAUDE.md — AI Coach

Board-exam-aligned AI tutor for Indian students and teachers. Mobile app (students/teachers), web app (Admin / Institution POC / Teacher), Cloudflare backend, all LLM calls via one OpenRouter account, prepaid hierarchical credits.

## Start of every session (do this first)

1. Read [docs/progress.md](docs/progress.md). It holds the **current phase**, what's done, what's next, open bugs, and the session log.
2. Run `git status` and `git log --oneline -10` to see where the code actually is. If it disagrees with progress.md, trust the code and fix progress.md.
3. Read the matching phase section in [docs/architecture.md](docs/architecture.md) §7 (and any §3/§6 sections it references) before writing code.
4. Work out the mode from the user's request:
   - **Implement:** continue the current phase's unchecked items in order.
   - **Fix:** reproduce first (failing test), fix, keep all tests green. Any phase can be fixed at any time.
   - **Change of design:** update architecture.md first (and the decisions log in §9), then code.

## End of every session (always)

- Update [docs/progress.md](docs/progress.md): tick finished items, add a dated session-log entry (what was done, what's next, blockers), record new bugs and decisions.
- Never leave the build or tests red without writing that down in progress.md under *Known issues*.

## Working rules

- **Environments (user rule, 2026-11-08):** LOCAL, STAGING and PRODUCTION are kept strictly separate ([docs/setup-and-deployment.md](docs/setup-and-deployment.md)).
  - **During a phase, build and test on LOCAL only.** Don't deploy to staging, set staging secrets or run staging migrations mid-phase.
  - **Only when a phase is complete:** commit + push, CI green, set that phase's new staging secrets, `pnpm deploy:staging`, the user tests on staging, then sign-off.
  - PRODUCTION doesn't exist yet. Never point anything at it.
  - **Exception (user decision 9.4-1, 2026-11-09):** textbook content lives in one **shared content store** used by LOCAL and STAGING: Vectorize `aicoach-content-chunks` + R2 `aicoach-content`. Processing a PDF happens once; each environment imports the versioned book package into its own D1. Only ever **add** to the shared store; never delete from it in scripts, tests or clean-ups (architecture §3.3).
  - Every phase section in progress.md lists the staging secrets/steps it will need at phase end.
- **One phase at a time** (§7 of the architecture doc). A phase is done only when its *Test & exit criteria* pass **and the user signs off** after a demo. Don't start the next phase without that sign-off.
- **Commit only when the user asks** (or when the user has approved a commit-per-phase routine). Never commit secrets.
- **Worker entry module** (`apps/worker/src/index.ts`) may only export handlers/functions; workerd refuses to start otherwise (test: `test/entry.test.ts`).
- **D1 limit:** at most 100 bound parameters per query. Don't build huge `IN (...)` lists.
- Keep architecture.md the source of truth. If implementation forces a design change, update the doc in the same change.
- Prefer small, tested, vertical increments over large untested drops.

## Non-negotiable engineering invariants

- **Money:** wallet amounts are **integer micro-INR** (`packages/core/src/money.ts`), never floats. `1 credit = ₹1 = 1e6 micro`. Provider cost is integer nano-USD, converted at the Admin-set USD→INR rate (stored per usage row). Users only ever see ₹; the fee %, rate and USD cost are Admin-only. The wallets table has `CHECK(balance >= held >= 0)`; move money only in D1 batches via `src/credits/ledger.ts` / `meter.ts`. Billed = OpenRouter actual cost (USD) × rate × (1 + fee_pct), fee_pct default 10%, stored per usage row. Ledger is **append-only**. Edits are new entries. Allotment lifecycle: allot → (giver may edit while open; an edit clears the acknowledgement) → receiver acknowledges → giver locks → immutable.
- **LLM calls:** always go through `runMeteredChat` in `apps/worker/src/llm/run.ts` (registry → optional AI Gateway → OpenRouter), which does the **metering** hold → settle path. Ask for a **task** (`tutor_chat`, `grading`, …), never hard-code a model slug. The model comes from the admin-managed `model_registry` (default `google/gemini-2.5-flash`). A cache hit is charged 0.
- **Grounding:** learner-facing factual answers carry textbook citations, or an explicit "not in your textbook"/uncertainty flag.
- **Authorisation:** enforced in the API. Tenant (institution) scoping on every query. Usage visibility = own node + immediate downline, except Admin, who sees the full tree.
- **Engagement policy:** no loss framing, fake urgency, public leaderboards or variable rewards. Notifications respect caps and quiet hours (architecture §6.1).
- **Safety:** distress → fixed handoff response + parent alert (email via the `Notifier` interface), never an LLM pep talk. Every free-text learner turn goes through `classify` (`src/safety`) before any model call; a model may only *flag* distress, never write the reply. The learner's words are never stored in `safety_events`. Add every missed phrase to `test/fixtures/safety-redteam.ts` first, then fix the rule.
- **Journeys:** the learner's path is decided by the graph (pure code in `packages/journeys`), never by a model: the SessionAgent does the I/O and feeds the *result* in as an event. Every edge needs a test (the coverage test fails otherwise). A step that fails must leave the checkpoint unchanged.
- **Secrets:** `.dev.vars` / `wrangler secret` only. Never in code or committed files.

## Tech stack (summary; details in architecture §5)

TypeScript monorepo (pnpm workspaces + Turborepo) · Expo/React Native (mobile) · React + Vite (web) · Hono on Cloudflare Workers · Durable Objects (Agents SDK) · Workflows · D1 (Drizzle) · R2 · Vectorize · KV · Workers AI (embeddings/reranker/safety) · AI Gateway → OpenRouter · Better Auth (email+password, email-OTP 2FA) · Vitest / Playwright / Maestro · custom eval harness in `evals/`.

## Repository map

```
apps/mobile      Expo app
apps/admin-web   React + Vite web app (Admin / POC / Teacher areas); e2e/ = Playwright (LOCAL only)
apps/worker      Cloudflare Worker: Hono API (src/routes), credits (src/credits), LLM path + prompts (src/llm),
                 textbooks + Q&A (src/content: store, chunk, ingest, workflow, import, scope, retrieve, answer),
                 board strategy (src/strategy), learning material (src/assets: notes, cards, questions, graph,
                 checks, reviews, share = publish/import), study sessions (src/sessions: agent = SessionAgent
                 Durable Object, plan, tutor, records), safety (src/safety: rules, classify, handoff),
                 cron (src/cron.ts);
                 scripts/ = make-admin, cleanup-test-data, upload-board-material
packages/core    domain types, Zod schemas, money (micro-INR / nano-USD), LLM task list, exam strategy +
                 learning asset schemas, LaTeX → plain text (latex.ts), journey graph engine (journey.ts),
                 session views + recall schedule (session.ts), calculator check (arithmetic.ts)
packages/journeys journey graphs, their views and outcomes (explain.ts, memorise.ts; pure, 100% transition
                 coverage in journeys.test.ts), fixed safety wording (copy.ts)
packages/db      Drizzle schema + migrations + seed (reference data only)
packages/ui-tokens design tokens
evals/           golden sets (golden/*.jsonl, optional `type`: journal/table/figure/formula) + runner
                 (run.mjs, LOCAL only, scores per type); results/ is git-ignored
docs/            architecture.md (design), progress.md (status), setup-and-deployment.md + environments/
                 (how to run/deploy), engagement-policy.md (review checklist), feature_description.txt (spec)

Retrieval/citations/cache live in apps/worker/src/content (no separate packages/rag needed so far).
```

*(Keep this map current when the structure changes.)*

## Commands

Human runbooks, one per environment: [local](docs/environments/local.md) · [staging](docs/environments/staging.md) · [production (planned)](docs/environments/production.md), with an overview in [docs/setup-and-deployment.md](docs/setup-and-deployment.md). Keep them in sync when commands or flows change.

Run from the repo root unless noted. On Windows, pnpm is installed in `%APPDATA%
pm` via Corepack (`corepack enable pnpm --install-directory "$APPDATA/npm"`).

| Task | Command |
|---|---|
| Install | `pnpm install` |
| First-time local DB | `pnpm db:migrate:local && pnpm db:seed:local` |
| Local secrets | copy `apps/worker/.dev.vars.example` to `apps/worker/.dev.vars` and set `BETTER_AUTH_SECRET` |
| Dev: API + built web app | `pnpm dev:worker` (http://localhost:8787, also on the LAN IP for phones) |
| Dev: web app with hot reload | `pnpm dev:web` (http://localhost:5173, proxies `/api` to :8787) |
| Dev: mobile (LOCAL backend) | `pnpm dev:mobile`, then scan the QR code in Expo Go (phone on the same Wi-Fi). API URL is auto-derived |
| Mobile against STAGING (phase end only) | `pnpm dev:mobile:staging` |
| Android APK that talks to STAGING (Expo cloud build; phase end only) | `pnpm build:apk:staging` (profile `staging-apk` in `apps/mobile/eas.json`; staging.md §3e) |
| Read dev emails (OTP, consent links) | printed in the `dev:worker` terminal, or `GET /api/dev/outbox?to=<email>` (development only) |
| Make a user Admin | `pnpm make-admin:local <email>` / `pnpm make-admin:staging <email>` |
| Typecheck all | `pnpm typecheck` |
| Tests (Workers runtime + local D1) | `pnpm test` |
| Web E2E (needs `dev:worker` running or starts it; LOCAL only, cleans up its test data afterwards) | `pnpm --filter @aicoach/admin-web test:e2e` |
| Remove leftover test data from the local DB | `pnpm cleanup-test:local` |
| Lint | `pnpm lint` |
| Answer-quality evals (LOCAL, needs ingested books) | `node evals/run.mjs --email <admin> --password <pw> [--model <slug>]` |
| Format | `pnpm format` / `pnpm format:check` |
| New DB migration | edit `packages/db/src/schema.ts`, then `pnpm db:generate` and `pnpm db:migrate:local` |
| Mobile bundle check | `cd apps/mobile && npx expo export --platform android --output-dir <tmp>` |
| Deploy staging (phase end only) | `pnpm deploy:staging` (builds web, applies remote migrations, deploys) |
| Staging logs (sign-in codes) | `pnpm logs:staging` |

## Environment notes

- The developer machine is Windows. Shell tools available: PowerShell and Git Bash. Node 24, npm 11, Python 3.12. pnpm comes via Corepack. wrangler is a project dev-dependency (use `pnpm wrangler …`).
- Pilot scope: KSEAB 2nd PUC Accountancy, English, NCERT textbooks.
