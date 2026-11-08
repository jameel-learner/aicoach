# AI Coach: Setup & Deployment Guide

How to install, run and try the whole application on a Windows PC and an Android phone, plus how deployment to Cloudflare works.

| Section | When you need it |
|---|---|
| [1. One-time machine setup](#1-one-time-machine-setup) | New PC, or fresh clone of the repo |
| [2. Running locally (every day)](#2-running-locally-every-day) | Each time you work on or demo the app |
| [3. First-time walkthrough (10 steps)](#3-first-time-walkthrough-10-steps) | First run on a fresh local database, or a full demo |
| [4. Stopping](#4-stopping) | End of a session |
| [5. Troubleshooting](#5-troubleshooting) | Something doesn't work |
| [6. Deploying to Cloudflare (staging)](#6-deploying-to-cloudflare-staging) | Putting the app online |
| [7. Useful commands](#7-useful-commands) | Quick reference |

> **How sign-in works:** there are no ready-made accounts or passwords. Everyone signs up with their own email and a password they choose. Every sign-in then needs a **6-digit code**. Locally no email is sent; the code is printed in the **server terminal** (Terminal 1).

---

## 1. One-time machine setup

Do this once per PC.

**Needed on the PC:** Node.js 22 or later (24 recommended) and Git. On the phone: the **Expo Go** app from the Play Store, with the phone on the **same Wi-Fi** as the PC.

Open **PowerShell** and run:

```powershell
# 1) pnpm (package manager). Installed into your user folder, so no admin rights are needed.
corepack enable pnpm --install-directory "$env:APPDATA\npm"
pnpm --version

# 2) Get the code and install dependencies
cd E:\repository
git clone https://github.com/jameel-learner/aicoach.git   # skip if already cloned
cd E:\repository\aicoach
pnpm install

# 3) Local secrets file for the API (never committed to git)
Copy-Item apps\worker\.dev.vars.example apps\worker\.dev.vars
```

Open `apps\worker\.dev.vars` in an editor and set `BETTER_AUTH_SECRET` to a long random string. To generate one:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Leave `TURNSTILE_SECRET_KEY` as the test value already in the file (it always passes locally).

```powershell
# 4) Create the local database and load the pilot data (KSEAB → 2nd PUC → Accountancy)
pnpm db:migrate:local
pnpm db:seed:local

# 5) Build the web app once (the API server serves it on port 8787)
pnpm --filter @aicoach/admin-web build
```

> The NCERT textbook PDFs go in `docs\textbooks\`. That folder is git-ignored and is only needed from Phase 2.

---

## 2. Running locally (every day)

Use **two terminals** so you can watch the server output.

**Terminal 1: API server + web app** (keep it visible: sign-in codes and parent-consent links appear here)

```powershell
cd E:\repository\aicoach
pnpm dev:worker
```

Wait for `Ready on http://0.0.0.0:8787`. It also prints the LAN address, e.g. `http://192.168.1.39:8787`.

- Web app on the PC: **http://localhost:8787**
- Health check: http://localhost:8787/api/health shows `{"ok":true,...}`

**Terminal 2: mobile app**

```powershell
cd E:\repository\aicoach
pnpm dev:mobile
```

Scan the QR code with **Expo Go**. The app finds the API automatically at `http://<PC-LAN-IP>:8787`.

**Optional: web app with live reload while editing UI code:** `pnpm dev:web` opens http://localhost:5173 (it uses the API on 8787, so Terminal 1 must be running).

> After changing web app code, either use `pnpm dev:web`, or rebuild with `pnpm --filter @aicoach/admin-web build` so port 8787 serves the new version.

---

## 3. First-time walkthrough (10 steps)

This creates one account of each role and links them: **Admin → Institution (POC) → Class (Teacher) → Student (+ Parent consent)**.

**Tip: one Gmail, many accounts.** The app treats Gmail "+" addresses as different users:

| Role | Example email |
|---|---|
| Admin | `jameel.learner@gmail.com` |
| Institution POC | `jameel.learner+poc@gmail.com` |
| Teacher | `jameel.learner+teacher@gmail.com` |
| Student | `jameel.learner+student@gmail.com` |
| Parent | `jameel.learner+parent@gmail.com` |

### Step 1: Start the server
In **Terminal 1**: `pnpm dev:worker` (see [section 2](#2-running-locally-every-day)). Keep it visible.

### Step 2: Create your account (web)
1. Open **http://localhost:8787** and click **Create an account**.
2. Enter your name, `jameel.learner@gmail.com`, a password you choose (8+ characters), and **I am a: Teacher**.
3. Wait for the "I'm not a robot" check to tick, then click **Create account**.

> Nobody can sign up as Admin or POC directly; that's deliberate. Admin is granted in Step 3, POC in Step 6.

### Step 3: Promote yourself to Admin
In **Terminal 2**:

```powershell
cd E:\repository\aicoach
pnpm --filter @aicoach/worker db:make-admin:local -- jameel.learner@gmail.com
```

The output should list your email with `"role": "admin"`. An **empty** result means the account doesn't exist yet; finish Step 2 first.

### Step 4: Sign in as Admin and add an institution
1. At http://localhost:8787, sign in with your email and password, then click **Continue**.
2. Find `Your sign-in code is ######` in **Terminal 1**, type it in, and click **Verify and sign in**.
3. The menu shows **Institutions**, **Boards & subjects** and **Users**.
4. **Institutions** → **Add institution**: e.g. *Vidya PU College*, type *college*, city *Mysuru* → **Add**.

### Step 5: Create the POC and Teacher accounts
Open a **private/incognito window** (so the Admin stays signed in in the normal window). Then:
1. **Create an account** for `jameel.learner+poc@gmail.com` as **Teacher**.
2. **Create an account** for `jameel.learner+teacher@gmail.com` as **Teacher**.

### Step 6: Make the POC (Admin window)
1. **Institutions** → click **POCs** on your institution.
2. Enter `jameel.learner+poc@gmail.com` → **Assign POC**.

### Step 7: Create a class (as POC, incognito window)
1. Sign in as `+poc` (code from Terminal 1) and click the **institution name** in the menu.
2. **Add class**: Subject **KSEAB · 2nd PUC · Accountancy**, name *2nd PUC Commerce A* → **Create class**.
3. In the class row, enter `jameel.learner+teacher@gmail.com` → **Assign**.
4. **Write down the 8-character join code** shown in the row. Students use it to join.

### Step 8: Student on the phone
1. Make sure Terminal 2 is running `pnpm dev:mobile` and open the app in Expo Go.
2. **New here? Create an account** → **Student**, `jameel.learner+student@gmail.com`, a password → **Create account**.
3. **Sign in** with the same email and password → **Continue**.
4. On **Enter your code**, type the code from Terminal 1. Use the **latest** code, because each Continue makes a new one.
5. **Parent screen:** name, `jameel.learner+parent@gmail.com`, tick the box → **Continue**.
6. **Join your class:** enter the join code from Step 7.
7. You land on **Home**. The **Me** tab shows parent consent as *Waiting for them to confirm*.

### Step 9: Parent consent (PC browser)
1. In Terminal 1, find the email **"Please confirm consent for …"**.
2. Open its link (`http://localhost:8787/api/parent-consent?token=…`) in a browser on the PC → **I confirm**.
3. On the phone, reopen the **Me** tab. Consent shows **Confirmed**.

### Step 10: Check the teacher view (web)
Sign in as `+teacher` → **My classes** → open the class. The student is listed.

All four roles are now set up. Next time, just start the servers ([section 2](#2-running-locally-every-day)) and sign in; the local data is kept.

---

## 4. Stopping

Press **Ctrl+C** in each terminal; if asked *Terminate batch job (Y/N)?*, press **Y**.

Local data (accounts, institutions, classes) is kept in `apps\worker\.wrangler\` and survives restarts.

**Start over with an empty local database** (deletes all local accounts and data):

```powershell
cd E:\repository\aicoach
Remove-Item -Recurse -Force apps\worker\.wrangler\state
pnpm db:migrate:local
pnpm db:seed:local
```

---

## 5. Troubleshooting

| Problem | Fix |
|---|---|
| **"Address already in use" / port 8787 busy** when starting `dev:worker` | An old server is still running. Close other terminals running it, or stop it: `Get-NetTCPConnection -LocalPort 8787 -State Listen \| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }` |
| **Phone shows "Can't reach AI Coach"** | Phone and PC on the same Wi-Fi? Open `http://<PC-LAN-IP>:8787/api/health` in the phone's browser. If it doesn't load, allow **workerd.exe** and **Node.js** on *Private* networks in Windows Firewall. |
| **Code is rejected** | Use the newest code in Terminal 1 (each sign-in attempt creates a new one; codes expire after 10 minutes). Tap **Send a new code** if needed. |
| **"Too many requests"** | You hit the sign-in rate limit. Wait one minute. |
| **Continue / Create account button stays disabled** | The "I'm not a robot" check hasn't finished. It needs internet access to load. Wait a few seconds or reload the page/app. |
| **make-admin shows an empty result** | The email hasn't signed up yet, or has a typo. Sign up first (Step 2), then rerun. |
| **"User with this email not found"** when assigning POC/teacher | That person must create their account first (Step 5). |
| **"Only a teacher account can be a class teacher"** | The person signed up as Student. Sign up again with a different email as Teacher, or an Admin changes the role under **Users**. |
| **Web page shows "Web app not built yet"** | Run `pnpm --filter @aicoach/admin-web build`, then refresh. |
| **Mobile app doesn't show code changes** | Press **r** in the `dev:mobile` terminal, or shake the phone → **Reload**. |
| **Parent consent link says "not valid"** | A newer consent email replaced it (e.g. the student changed the parent's email). Use the latest link, or tap **Send the email again** on the phone's **Me** tab. |

---

## 6. Deploying to Cloudflare (staging)

> **Status:** not done yet. `wrangler login` was completed on 2026-11-08 (account jameel.outskill@gmail.com). The remaining steps are run together with Claude and this section is updated when staging is live.

Staging is an online copy of the app on Cloudflare's free plan, at `https://aicoach-api-staging.<your-subdomain>.workers.dev` (API + web app on one address).

**One-time setup:**

```powershell
cd E:\repository\aicoach\apps\worker

# 1) Confirm the Cloudflare login
pnpm exec wrangler whoami

# 2) Create the staging database; copy the printed database_id
pnpm exec wrangler d1 create aicoach-staging
```

3. In `apps\worker\wrangler.jsonc`, under `env.staging`, replace `REPLACE_WITH_STAGING_D1_ID` with that id, and `REPLACE_WITH_SUBDOMAIN` with your workers.dev subdomain (shown in the Cloudflare dashboard → Workers & Pages).

4. Set the staging secrets (each command asks for the value):
   ```powershell
   pnpm exec wrangler secret put BETTER_AUTH_SECRET --env staging     # new long random string, different from local
   pnpm exec wrangler secret put RESEND_API_KEY --env staging         # from resend.com → API Keys
   pnpm exec wrangler secret put TURNSTILE_SECRET_KEY --env staging   # from Cloudflare → Turnstile
   ```
   In Cloudflare → **Turnstile**, create a widget for the staging hostname and put its **site key** into `TURNSTILE_SITE_KEY` under `env.staging.vars` in wrangler.jsonc.

**Each deployment:**

```powershell
cd E:\repository\aicoach
pnpm --filter @aicoach/admin-web build
cd apps\worker
pnpm exec wrangler d1 migrations apply DB --remote --env staging
pnpm exec wrangler deploy --env staging
# first time only: load the pilot data
pnpm exec wrangler d1 execute DB --remote --env staging --file=../../packages/db/seed/seed.sql
```

**Make an Admin on staging** (after that person signs up on the staging site):

```powershell
node scripts\make-admin.mjs --env staging jameel.learner@gmail.com
```

**Email on staging:** without a verified domain, Resend only delivers to the Resend account owner's address (jameel.learner@gmail.com). Real users need a verified sender domain before the pilot.

**Mobile app against staging:** create `apps\mobile\.env` with `EXPO_PUBLIC_API_URL=https://aicoach-api-staging.<subdomain>.workers.dev` and restart `pnpm dev:mobile`.

**Automatic deploys (later):** `.github/workflows/ci.yml` can deploy staging on every push to `main` once the GitHub repo has secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and the repo variable `STAGING_DEPLOY_ENABLED=true`.

---

## 7. Useful commands

Run from `E:\repository\aicoach`.

| Task | Command |
|---|---|
| Install dependencies | `pnpm install` |
| Start API + web app | `pnpm dev:worker` |
| Start mobile dev server | `pnpm dev:mobile` |
| Web app with live reload | `pnpm dev:web` |
| Build web app | `pnpm --filter @aicoach/admin-web build` |
| Apply DB migrations (local) | `pnpm db:migrate:local` |
| Load pilot data (local) | `pnpm db:seed:local` |
| Make a user Admin (local) | `pnpm --filter @aicoach/worker db:make-admin:local -- <email>` |
| See recent dev emails (codes, links) | open `http://localhost:8787/api/dev/outbox?to=<email>` (local only) |
| Type-check everything | `pnpm typecheck` |
| Run all tests | `pnpm test` |
| Browser end-to-end tests | `pnpm --filter @aicoach/admin-web test:e2e` |
| Format code | `pnpm format` |
