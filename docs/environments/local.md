# LOCAL: Run AI Coach on your PC

**Use this throughout every phase while it's being built.** Everything runs on your PC: the API, the web app and a local database. The phone connects over your home Wi-Fi.

| | Local |
|---|---|
| Web app + API | http://localhost:8787 (phone: `http://<PC-LAN-IP>:8787`, e.g. `http://192.168.1.39:8787`) |
| Database | Local SQLite copy of D1 in `apps\worker\.wrangler\state` (survives restarts) |
| Sign-in codes & emails | Printed in the **server terminal** (no real email is sent) |
| Secrets | `apps\worker\.dev.vars` (git-ignored) |
| AI calls (from Phase 1) | Real calls to OpenRouter using the key in `.dev.vars`, so **local AI use costs real credits** |

Contents: [1. One-time setup](#1-one-time-setup) · [2. Start (every day)](#2-start-every-day) · [3. First-time walkthrough (10 steps)](#3-first-time-walkthrough-10-steps) · [4. After pulling new code](#4-after-pulling-new-code) · [5. Stop / reset](#5-stop--reset) · [6. Troubleshooting](#6-troubleshooting) · [7. Commands](#7-commands)

> **How sign-in works:** there are no ready-made accounts or passwords. Everyone signs up with their own email and a password they choose. Every sign-in then needs a **6-digit code**, which locally is printed in the server terminal.

---

## 1. One-time setup

**Needed:** Node.js 22+ (24 recommended), Git, and the **Expo Go** app on an Android phone that's on the **same Wi-Fi** as the PC.

In **PowerShell**:

```powershell
# 1) pnpm, installed into your user folder (no admin rights needed)
corepack enable pnpm --install-directory "$env:APPDATA\npm"
pnpm --version

# 2) Code + dependencies
cd E:\repository
git clone https://github.com/jameel-learner/aicoach.git   # skip if already cloned
cd E:\repository\aicoach
pnpm install

# 3) Local secrets file (never committed)
Copy-Item apps\worker\.dev.vars.example apps\worker\.dev.vars
```

Edit `apps\worker\.dev.vars`:

| Key | Value |
|---|---|
| `BETTER_AUTH_SECRET` | a long random string; generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `TURNSTILE_SECRET_KEY` | leave the test value (always passes locally) |
| `OPENROUTER_API_KEY` | your OpenRouter key `sk-or-...` (needed from Phase 1) |
| `RESEND_API_KEY` | leave empty locally |

```powershell
# 4) Local database + pilot data (KSEAB → 2nd PUC → Accountancy)
pnpm db:migrate:local
pnpm db:seed:local

# 5) Build the web app once (the API server serves it on :8787)
pnpm --filter @aicoach/admin-web build
```

> NCERT textbook PDFs go in `docs\textbooks\` (git-ignored; needed from Phase 2).

---

## 2. Start (every day)

Use **two terminals** so you can watch the server.

**Terminal 1: API + web app** (keep visible: codes and consent links appear here)

```powershell
cd E:\repository\aicoach
pnpm dev:worker
```

Wait for `Ready on http://0.0.0.0:8787`. Check http://localhost:8787/api/health: it should show `"env":"development"`.

**Terminal 2: phone app (local backend)**

```powershell
cd E:\repository\aicoach
pnpm dev:mobile
```

It prints `AI Coach mobile → LOCAL backend`. Scan the QR code with Expo Go. The sign-in screen and the **Me** tab show **"Local server · 192.168.x.x:8787"**, so you always know which server you're on.

**Optional: live-reload web UI while editing:** `pnpm dev:web` opens http://localhost:5173 (Terminal 1 must be running).

---

## 3. First-time walkthrough (10 steps)

Creates one account per role and links them: **Admin → Institution (POC) → Class (Teacher) → Student (+ Parent consent)**.

**One Gmail, many accounts:** Gmail "+" addresses count as different users here.

| Role | Example email |
|---|---|
| Admin | `jameel.learner@gmail.com` |
| Institution POC | `jameel.learner+poc@gmail.com` |
| Teacher | `jameel.learner+teacher@gmail.com` |
| Student | `jameel.learner+student@gmail.com` |
| Parent | `jameel.learner+parent@gmail.com` |

1. **Start the server:** Terminal 1 `pnpm dev:worker`.
2. **Create your account (web):** http://localhost:8787 → **Create an account** → your name, `jameel.learner@gmail.com`, a password you choose (8+ characters), **I am a: Teacher** → wait for the robot check to tick → **Create account**.
   *(Nobody can sign up as Admin or POC directly; that's deliberate.)*
3. **Promote yourself to Admin:** Terminal 2:
   ```powershell
   pnpm make-admin:local jameel.learner@gmail.com
   ```
   The output must show `"role": "admin"`. An empty result means the account doesn't exist yet; do step 2 first.
4. **Sign in as Admin:** sign in → **Continue** → type the code from Terminal 1 → **Verify and sign in**. Then **Institutions** → add one (e.g. *Vidya PU College*, college, Mysuru).
5. **Create POC and Teacher accounts:** in a **private/incognito window**, sign up `+poc` and `+teacher`, both as **Teacher**.
6. **Make the POC (Admin window):** **Institutions** → **POCs** on your institution → `jameel.learner+poc@gmail.com` → **Assign POC**.
7. **Create a class (as POC, incognito):** sign in as `+poc` → click the institution name → **Add class**: *KSEAB · 2nd PUC · Accountancy*, name *2nd PUC Commerce A* → **Create class** → in the row enter `+teacher` → **Assign**. **Note the 8-character join code.**
8. **Student on the phone:** Terminal 2 `pnpm dev:mobile`, then in Expo Go: **Create an account** (Student, `+student`) → **Sign in** → code from Terminal 1 (use the **latest** one) → **Parent** screen (`+parent`, tick the box) → **Join your class** with the join code → **Home**.
9. **Parent consent (PC browser):** in Terminal 1 find **"Please confirm consent for …"**, open its link → **I confirm**. The phone's **Me** tab shows **Confirmed**.
10. **Teacher view (web):** sign in as `+teacher` → **My classes** → open the class. The student is listed.

---

## 4. After pulling new code

When a phase adds dependencies or database changes:

```powershell
cd E:\repository\aicoach
pnpm install
pnpm db:migrate:local
pnpm --filter @aicoach/admin-web build
```

Then restart Terminal 1 and Terminal 2.

---

## 5. Stop / reset

**Stop:** **Ctrl+C** in each terminal (answer **Y** to *Terminate batch job*).

**Reset the local database** (deletes all local accounts and data):

```powershell
cd E:\repository\aicoach
Remove-Item -Recurse -Force apps\worker\.wrangler\state
pnpm db:migrate:local
pnpm db:seed:local
```

---

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| **Port 8787 already in use** | An old server is still running. Close it, or: `Get-NetTCPConnection -LocalPort 8787 -State Listen \| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }` |
| **Phone: "Can't reach AI Coach"** | Same Wi-Fi? Open `http://<PC-LAN-IP>:8787/api/health` in the phone browser. If it fails, allow **workerd.exe** and **Node.js** on *Private* networks in Windows Firewall. |
| **Phone shows "STAGING server"** | You started `dev:mobile:staging`. Stop it and run `pnpm dev:mobile`. |
| **Code rejected** | Use the newest code in Terminal 1 (each attempt creates a new one; 10-minute expiry). Tap **Send a new code**. |
| **"Too many requests"** | Rate limit; wait one minute. |
| **Continue / Create account stays disabled** | The robot check is still loading (needs internet). Wait or reload. |
| **make-admin shows an empty result** | That email hasn't signed up yet, or has a typo. |
| **"User with this email not found"** when assigning | That person must sign up first. |
| **"Only a teacher account can be a class teacher"** | The person signed up as Student. An Admin can change the role under **Users**. |
| **Web page: "Web app not built yet"** | `pnpm --filter @aicoach/admin-web build`, then refresh. |
| **Phone doesn't show code changes** | Press **r** in Terminal 2, or shake the phone → **Reload**. |
| **Parent consent link "not valid"** | A newer email replaced it; use the latest link, or **Send the email again** on the **Me** tab. |

---

## 7. Commands

Run from `E:\repository\aicoach`.

| Task | Command |
|---|---|
| Start API + web app | `pnpm dev:worker` |
| Start phone app (local backend) | `pnpm dev:mobile` |
| Web UI with live reload | `pnpm dev:web` |
| Build web app | `pnpm --filter @aicoach/admin-web build` |
| Apply DB migrations | `pnpm db:migrate:local` |
| Load pilot data | `pnpm db:seed:local` |
| Make a user Admin | `pnpm make-admin:local <email>` |
| Recent dev emails (codes, links) | http://localhost:8787/api/dev/outbox?to=&lt;email&gt; |
| Type-check everything | `pnpm typecheck` |
| Run all tests | `pnpm test` |
| Browser end-to-end tests | `pnpm --filter @aicoach/admin-web test:e2e` |
| Format code | `pnpm format` |
