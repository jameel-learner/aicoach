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

- **One phase at a time** (§7 of the architecture doc). A phase is done only when its *Test & exit criteria* pass **and the user signs off** after a demo. Don't start the next phase without that sign-off.
- **Commit only when the user asks** (or when the user has approved a commit-per-phase routine). Never commit secrets.
- Keep architecture.md the source of truth. If implementation forces a design change, update the doc in the same change.
- Prefer small, tested, vertical increments over large untested drops.

## Non-negotiable engineering invariants

- **Money:** store amounts as **integer micro-USD**, never floats. `1 credit = US$1`. Billed = OpenRouter actual cost × (1 + fee_pct), fee_pct default 10%, stored per ledger entry. Ledger is **append-only**. Edits are new entries. Allotment lifecycle: allot → (giver may edit while open; an edit clears the acknowledgement) → receiver acknowledges → giver locks → immutable.
- **LLM calls:** always go through `packages/llm` (router → AI Gateway → OpenRouter), and always go through the **metering** hold → settle path. Ask for a **task** (`tutor_chat`, `grading`, …), never hard-code a model slug. The model comes from the admin-managed `model_registry` (default `google/gemini-2.5-flash`). A cache hit is charged 0.
- **Grounding:** learner-facing factual answers carry textbook citations, or an explicit "not in your textbook"/uncertainty flag.
- **Authorisation:** enforced in the API. Tenant (institution) scoping on every query. Usage visibility = own node + immediate downline, except Admin, who sees the full tree.
- **Engagement policy:** no loss framing, fake urgency, public leaderboards or variable rewards. Notifications respect caps and quiet hours (architecture §6.1).
- **Safety:** distress → fixed handoff response + parent alert (email via the `Notifier` interface), never an LLM pep talk.
- **Secrets:** `.dev.vars` / `wrangler secret` only. Never in code or committed files.

## Tech stack (summary; details in architecture §5)

TypeScript monorepo (pnpm workspaces + Turborepo) · Expo/React Native (mobile) · React + Vite (web) · Hono on Cloudflare Workers · Durable Objects (Agents SDK) · Workflows · D1 (Drizzle) · R2 · Vectorize · KV · Workers AI (embeddings/reranker/safety) · AI Gateway → OpenRouter · Better Auth (email+password, email-OTP 2FA) · Vitest / Playwright / Maestro · custom eval harness in `evals/`.

## Repository map

```
apps/mobile      Expo app
apps/admin-web   React + Vite web app (Admin / POC / Teacher areas)
apps/worker      Cloudflare Worker: Hono API, Durable Objects, Workflows, cron
packages/core    domain types, Zod schemas, journey graph engine
packages/db      Drizzle schema + migrations
packages/rag     retrieval, rerank, citations, answer cache
packages/llm     model registry client, router, prompts, metering hooks
packages/journeys journey graph definitions
packages/ui-tokens design tokens
evals/           golden sets + eval runner
docs/            architecture.md (design), progress.md (status), feature_description.txt (original spec)
```

*(This structure is created in Phase 0. Update this section if it changes.)*

## Commands

*(Filled in during Phase 0. Keep this list accurate.)*

| Task | Command |
|---|---|
| Install | `corepack enable && pnpm install` |
| Dev (worker) | TBD |
| Dev (web) | TBD |
| Dev (mobile) | TBD |
| Tests | TBD |
| Evals | TBD |
| DB migration | TBD |
| Deploy | TBD |

## Environment notes

- The developer machine is Windows. Shell tools available: PowerShell and Git Bash. Node 24, npm 11, Python 3.12. pnpm comes via Corepack. wrangler is a project dev-dependency (use `pnpm wrangler …`).
- Pilot scope: KSEAB 2nd PUC Accountancy, English, NCERT textbooks.
