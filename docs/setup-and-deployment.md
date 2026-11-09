# AI Coach: Environments & How We Work

AI Coach runs in three separate environments. Each has its own guide, database, accounts and secrets, and nothing is shared between them.

| Environment | Guide | Used when | Address |
|---|---|---|---|
| **LOCAL** | [environments/local.md](environments/local.md) | **Throughout every phase** while it's being built and tested | http://localhost:8787 (phone: PC LAN IP) |
| **STAGING** | [environments/staging.md](environments/staging.md) | **Only at the end of a phase**, to deploy and test it before moving to the next phase | https://aicoach-api-staging.jameel-outskill.workers.dev |
| **PRODUCTION** | [environments/production.md](environments/production.md) | Real users. **Not created yet** (before the pilot) | your own domain (planned) |

**Shared between LOCAL and STAGING (from Phase 2):** the textbook content store (Vectorize index `aicoach-content-chunks` + R2 bucket `aicoach-content`). A textbook is processed once and imported into each environment's own database. Everything else (accounts, credits, data) stays separate. See architecture §3.3.

## Phase workflow

```
 ┌──────────── during a phase ────────────┐   ┌────── phase complete ──────┐
 │ build → test on LOCAL → fix → repeat    │ → │ commit + push → CI green   │
 │ (pnpm dev:worker + pnpm dev:mobile)     │   │ pnpm deploy:staging        │
 └─────────────────────────────────────────┘   │ test on STAGING → sign-off │
                                               └──────────────┬─────────────┘
                                                              ↓
                                                       next phase (LOCAL)
```

- **During a phase:** everything is tested on LOCAL only. Staging is not touched.
- **End of a phase:** deploy to staging once, test the finished phase there, sign off. Then the next phase starts.
- **Production** (later): a version is promoted only after it has passed on staging.

## Which command talks to which environment

| | LOCAL | STAGING | PRODUCTION |
|---|---|---|---|
| API + web app | `pnpm dev:worker` | `pnpm deploy:staging` | *(planned)* |
| Phone app | `pnpm dev:mobile` | `pnpm dev:mobile:staging` | store build *(planned)* |
| Sign-in codes / emails | server terminal | `pnpm logs:staging` | real email *(planned)* |
| Make a user Admin | `pnpm make-admin:local <email>` | `pnpm make-admin:staging <email>` | *(planned)* |
| Database migrations | `pnpm db:migrate:local` | included in `pnpm deploy:staging` | *(planned)* |
| Secrets live in | `apps\worker\.dev.vars` | Cloudflare (`--env staging`) | Cloudflare (`--env production`) |

The phone app always shows which server it's on (sign-in screen and **Me** tab): **"Local server · …"** or **"STAGING server"**.
