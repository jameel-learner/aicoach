# AI Coach — Progress

> Single source of truth for **where the build is**. Claude reads this at the start of every session and updates it at the end.
> Design lives in [architecture.md](architecture.md). Phase details and exit criteria are in §7 of that document.

## Current status

| | |
|---|---|
| **Current phase** | Phase 0: Foundations (not started) |
| **Last updated** | 2026-11-08 |
| **Build / tests** | n/a (no code yet) |
| **Blockers** | Prerequisites below (accounts / keys) |

Status legend: ⬜ not started · 🟡 in progress · ✅ done (exit criteria passed + user sign-off) · ⛔ blocked

## Prerequisites (user-provided)

| Item | Needed by | Status |
|---|---|---|
| Cloudflare account (jameel.outskill@gmail.com); user runs `pnpm wrangler login` once (browser sign-in) | Phase 0 deploy | 🟡 account ready, login pending |
| GitHub remote `jameel-learner/aicoach` | Phase 0 CI | ✅ remote configured |
| Email sending: Resend account (jameel.learner@gmail.com). Without a verified domain, Resend only delivers to the account owner's address (fine for dev). **A sender domain is needed before the pilot** | Phase 0 (dev: console log) | 🟡 |
| Android phone with Expo Go (connects by QR code on the same Wi-Fi) | Phase 0 mobile shell | ✅ |
| OpenRouter API key, stored **only** in `apps/worker/.dev.vars` and `wrangler secret`. The key pasted in chat on 2026-11-08 should be **rotated** first | Phase 1 | 🟡 rotate, then store |
| NCERT Accountancy PDFs: `docs/textbooks/accountancy_1.pdf` (~204 pp), `accountancy_2.pdf` (~296 pp). Git-ignored | Phase 2 | ✅ |
| KSEAB 2nd PUC Accountancy blueprint / model papers / marking scheme | Phase 3 | ⬜ |

## Phase overview

| Phase | Name | Status |
|---|---|---|
| 0 | Foundations | ⬜ |
| 1 | LLM gateway, model switching & credits | ⬜ |
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

### Phase 0: Foundations ⬜
- [ ] Monorepo scaffold (pnpm workspaces, Turborepo, TS strict, ESLint/Prettier, Vitest)
- [ ] `apps/worker`: Hono app, wrangler config with dev/staging/prod envs, health endpoint
- [ ] `packages/db`: Drizzle + D1 schema v1 (users, roles, institutions, class_groups, boards/classes/subjects/offerings, enrolments, parent_contacts, consents, audit_log) + migrations
- [ ] Seed: KSEAB → 2nd PUC → Accountancy
- [ ] Better Auth: email+password, email-OTP 2FA on by default, Turnstile, roles (Admin, Institution POC, Teacher, Student)
- [ ] `Notifier` interface + email adapter (Resend)
- [ ] RBAC + tenant-scoping middleware
- [ ] `apps/admin-web`: login/2FA, role areas (Admin: taxonomy, institutions, users/enrolments · POC: classes, teachers · Teacher: my classes/students)
- [ ] `apps/mobile`: Expo shell, login/2FA, onboarding with parent contact + consent, enrolment picker, vertical-first nav
- [ ] Design tokens + accessibility baseline
- [ ] Engagement policy document (§6.1) as review checklist
- [ ] CI (GitHub Actions): lint, typecheck, tests. Deploy to staging
- [ ] Fill in the CLAUDE.md *Commands* table
- [ ] **Exit:** E2E sign-up → 2FA → login per role; RBAC/tenant tests; deploy works; user sign-off

### Phase 1: LLM gateway, model switching & credits ⬜
- [ ] OpenRouter client via AI Gateway (streaming, `usage.cost`, generation ID, gateway cache-hit detection)
- [ ] `model_registry` + nightly sync from OpenRouter `/models`. Admin Models screen (per task, capability filter, fallback, price, eval score)
- [ ] Wallet tree + `allotments` (open/locked, consent-based corrections) + append-only ledger
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

*(none yet)*

## Pending confirmations

*(none. Allotment lifecycle confirmed 2026-11-08: allot → spend → receiver acknowledges → giver locks; edits only while open.)*

## Session log

### 2026-11-08
- Wrote architecture.md v2 (AI approach, stack, phases), recorded all Section 9 decisions, created CLAUDE.md and progress.md.
- Confirmed allotment lifecycle. Prerequisites recorded. Added .gitignore (textbooks + secrets excluded).
- Next: start Phase 0.
