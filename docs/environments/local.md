# LOCAL: Run AI Coach on your PC

**Use this throughout every phase while it's being built.** Everything runs on your PC: the API, the web app and a local database. The phone connects over your home Wi-Fi.

| | Local |
|---|---|
| Web app + API | http://localhost:8787 (phone: `http://<PC-LAN-IP>:8787`, e.g. `http://192.168.1.39:8787`) |
| Database | Local SQLite copy of D1 in `apps\worker\.wrangler\state` (survives restarts) |
| Sign-in codes & emails | Printed in the **server terminal** (no real email is sent) |
| Secrets | `apps\worker\.dev.vars` (git-ignored) |
| Textbook content (from Phase 2) | **Shared with staging**: Vectorize `aicoach-content-chunks` + R2 `aicoach-content` on Cloudflare (needs internet and `wrangler login`). A book processed here is imported on staging without re-processing |
| AI calls (from Phase 1) | Real calls to OpenRouter using the key in `.dev.vars`, so **local AI use costs real OpenRouter credit** |

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

## 3b. Credits & AI walkthrough (Phase 1)

Do this after the 10 steps above (same accounts). **AI calls are real and cost real OpenRouter credits**, but only fractions of a paisa each. All amounts are in **rupees** (1 credit = ₹1); only the OpenRouter balance is in US$.

1. **Admin → AI models → Sync from OpenRouter.** About 400 models load. The table lists the four selectable ones (Gemini 2.5 Flash, Claude Sonnet 5.5, Claude Haiku 5.5, GPT-4o mini) with prices. Under *Model per feature*, every feature uses `google/gemini-2.5-flash` by default. *Voice input* only offers Gemini (the only one that takes audio).
2. **Admin → Credits & payments.**
   - *Platform float* shows your real OpenRouter balance in US$ with the ₹ equivalent.
   - *Fee and exchange rate*: the fee (10%) and the USD→INR rate (₹88.00) are visible **only here**. Adjust the rate if you like (e.g. `88.50`).
   - **1. Record an offline payment:** Credit purchase, paid by *Institution* (your college), e.g. ₹8350, UPI → **Record payment**. Step 2 is now pre-filled with ₹8350.
   - **2. Issue credits:** change the amount if needed → **Issue credits**. The institution appears under *Top-level wallets*.
   - Issue a small amount (e.g. `50`) **To: Platform wallet** for your own testing.
3. **Admin → AI playground:** send a prompt. You see the answer, the model, the OpenRouter cost (US$) and the charge (₹). On the platform wallet there's no fee.
4. **POC (incognito) → Credits:** the institution shows *1 to confirm*. Open it → **Confirm received**. In *Your downline*, give e.g. `2500` to the class → **Give**.
5. **POC buys more from Admin:** on the institution wallet → *Buy credits*: amount `5000`, UTR `412345678901`, paid by UPI → **Submit payment**. *Your requests* shows *Waiting for reply*.
6. **Admin → Credits & payments → Payments to verify:** the POC's payment is listed with the UTR (also in *Payments* as *To verify*). **Confirm & issue** → the institution gets ₹5000 and the payment becomes *Verified*. (Try **Reject** with a comment on another one: the payer sees the comment.)
7. **Admin → Wallets → your institution:** the allotments show *Confirmed by receiver* → **Lock**. Try **Correct** on an unlocked allotment: the receiver must confirm again before it can be locked.
8. **Teacher → Credits:** the class shows ₹2,500. Give some to the student. Then **AI playground** → *Pay from: the class* → send. The charge is in ₹; the teacher never sees the model, the US$ cost or the fee.
9. **Phone (student) → Me → My credits:** balance in ₹, **Confirm received** for the teacher's allotment, then **Request credits** (amount + send). On the web, the **teacher's Credits page** shows *Credit requests waiting for you* → **Accept** (optionally a different amount) or **Reject** with a comment. The phone shows the reply and comment (pull to refresh / reopen Me).
10. **Teacher asks the POC:** teacher → class wallet → *Need more credits?* → amount → **Request credits**. POC → Credits → **Accept** / **Reject**.
    **Teacher buys for themself:** teacher → Credits → the *My own credits* card → **Buy credits** → amount paid, UTR → **Submit payment** (on the phone: Me → My credits → *I have paid: add credits*). Admin confirms it under *Payments to verify*; the teacher's own balance goes up.
11. **Change the class teacher** (POC or Admin → the institution page → **Change** next to the class teacher → another teacher's email → **Reassign**). The page says how much unused class credit went back to the institution. Check: the institution's Credits page shows the return (locked), the old teacher no longer sees the class or its wallet, their **own** credits and the students' credits are unchanged, and the new teacher sees the class wallet at ₹0. Reassign back if you like.
12. **POC → Credits → institution:** *Your downline* shows the class's usage. The POC can open the class wallet but not the student's (immediate downline only).
13. **Admin → AI models:** switch *Admin/Teacher playground* to `openai/gpt-4o-mini`. Within ~30 seconds the playground answers from that model (shown in the answer). Switch it back.

## 3c. Textbooks walkthrough (Phase 2)

Processes the NCERT books **once** into the shared content store (staging later imports them for free). Real cost: about **US$0.0022 per page**, ≈ US$1.10 for both books, paid from the platform wallet.

1. Restart Terminal 1 (`pnpm dev:worker`). Its start-up list must show `CONTENT_VECTORS`, `CONTENT` and `AI` as **remote** and `INGEST_BOOK` (needs internet + `wrangler login`).
2. **Admin → Credits & payments → Issue credits → To: Platform wallet**, e.g. `150` (₹; covers both books with margin).
3. **Admin → Textbooks → Upload:** `docs\textbooks\accountancy_1.pdf`, title *NCERT Accountancy Class 12 Part I*, subject *KSEAB · 2nd PUC · Accountancy* → **Upload** (free).
4. Open the book → **Read all pages**. Progress updates every few seconds (about 3 to 4 minutes for 204 pages; you can leave the page). *OCR spent so far* shows the real cost. When it finishes, the status changes to **Review** and every page box is **white** (= read). That is the end of the automatic part: nothing turns green by itself. **Red** appears only for pages that failed to read; an underline marks a page worth checking (*garbled*, *empty*, *short*). **Keep `pnpm dev:worker` running and unchanged while it reads:** restarting it (or code changes, which reload it) stops the reading. If the page then says *Reading stopped* (no progress for 10 minutes), press **Continue reading**: pages already done are kept and not paid for again.
5. **Review:** click **Needs a look** to see failed/flagged pages. Compare the PDF (left) with the text (right). Fix anything wrong → **Save edits & next**, or **Read this page again**. A page turns **green** when you click **Approve & next**, **blue** when you save an edit. Approving every page is optional; publishing needs only that no page is grey or red. Spot-check a few balance-sheet pages: tables should be `| column |` rows.
6. **Publish.** Status becomes *Published v1*; the book appears under *Shared content store* as *Up to date*.
7. **Institutions using this book:** tick your institution → **Save**.
8. Repeat 3 to 7 for `accountancy_2.pdf` (*Part II*, 296 pages).
9. **Ask (web):** on any page, click **Ask your textbook** (bottom right). Ask e.g. *What is goodwill?* The answer streams in, with page badges (click one to see the source text). Ask the same again: *Saved answer · free*. **Get a new answer** makes another version. Try an off-syllabus question (*Who won the 2011 World Cup?*): it says *Not in your textbook*. **Expand** widens the drawer. **Follow-ups:** ask *Importance of a balance sheet*, then *What are its limitations?*: the second shows *Answering: What are the limitations of a balance sheet?* and cites the right pages.
10. **Ask (phone):** as the student, open the **Learn** tab and ask a question. The charge comes from the student's class wallet (then own).
11. **Evaluation:** in a new terminal, `node evals/run.mjs --email <your admin email> --password <your password>` (≈ US$0.05). It prints citation accuracy (target ≥ 90%) and correctness (target ≥ 85%); **Admin → AI models** shows the scores. Add `--model openai/gpt-4o-mini` to compare models. Scores are also shown **per question type** (concept, journal, table, figure, formula, not in book). A LOCAL-only eval Admin `evals-admin@aicoach.local` exists (its password isn't stored anywhere; use your own Admin account, or reset it with *Forgot password*, codes in the dev outbox).

## 3d. Board material (Phase 3)

Reads the KSEAB board files **once** into the shared content store, as with the textbooks. They feed the exam strategy and are **never** searched by *Ask your textbook*. Files live in `docs\board-material\kseab-2puc-accountancy\<category folder>\` (git-ignored). Real cost: about **US$0.93** to read the 410 English pages that are uploaded (the analysis step comes later), paid from the platform wallet. `pages-to-remove.json` in that folder lists the pages that are **not** uploaded (Kannada versions, blank pages, papers repeated inside the question bank), with the reason for each; edit it if needed. Your original files are not changed.

1. Restart Terminal 1 (`pnpm dev:worker`): it applies migration `0004_phase3_board_material`. **Leave it running and unchanged until step 4 is done** (a restart stops the reading).
2. **Platform wallet:** make sure it has at least ₹150 (Admin → Credits & payments).
3. **See the plan** (nothing is uploaded):

   ```powershell
   pnpm upload-board:local --dry-run
   ```

   It lists 23 documents with category, academic year and the pages removed, skips the byte-identical *scheme of evaluation* copy and the content-identical 2025-26 blueprint, links each `_Answers.pdf` to its paper, and removes each centum script's cover page (register number) and the pages in `pages-to-remove.json` **before** upload. Expected: *23 documents, 410 pages ≈ US$0.93*.
4. **Upload and read everything** (Terminal 2; about 20 to 30 minutes, one document at a time):

   ```powershell
   pnpm upload-board:local --email <your admin email> --password <your password> --read
   ```

   Progress and the cost per document are printed. If it stops (e.g. the server restarted), run the same command again: uploads aren't repeated and reading continues where it stopped.
5. **Review:** Admin → Textbooks → **Board material**. A document with pages left out shows a *Pages left out before storing* card (original page numbers + why each range was left out); page tiles and the page viewer also show each page's **original** page number, because the stored copy is numbered from 1 again. Documents uploaded before reasons were recorded: run the step 4 command again **without** `--read`; it only records the reasons (nothing is uploaded or read again). Open the documents with underlined (flagged) pages; compare PDF and text as for the textbooks. Spot-check a centum script: no register number or name should appear in the text.
6. **Publish** each board document (as for textbooks). Institutions aren't needed for board material.
7. Tell Claude when done: the analysis step (exam strategy) is built next.

## 3e. Exam strategy (Phase 3)

Compiles the KSEAB strategy from the published board material (3d). Real cost about **US$0.7** (shown on the button), paid from the platform wallet; nothing is charged to learners.

1. Restart Terminal 1 (`pnpm dev:worker`): it loads the new `COMPILE_STRATEGY` workflow and applies migration `0006`. **Leave it running and unchanged** until the compile finishes (10 to 20 minutes).
2. **Admin → Exam strategy** → subject *KSEAB · 2nd PUC · Accountancy* → **Compile strategy**. Progress shows step by step (pattern, papers, question bank, schemes, presentation, topics).
3. If it stops (server restarted, or the platform wallet ran out): **Continue compiling**. Finished steps aren't repeated or paid again.
4. **Review the draft:** the checks (⚠ = something to look at), *What matters most*, the paper pattern, each chapter (click it: allowed problem types, topics most asked first, the questions with their marking from the schemes), marks allotment, presentation rules from the centum scripts.
5. **Approve** when it looks right (a review note is optional). Recompiling later makes a new version; approving it supersedes the old one.

## 3f. Learning material: notes (Phase 3)

Notes per topic and marks level from the **approved** strategy (3e). Development uses Gemini (all notes ≈ US$1.5–2); everything is regenerated with Claude Opus or Sonnet before production (decision 9.5-4).

1. Restart Terminal 1 (`pnpm dev:worker`): it loads the `GENERATE_ASSETS` workflow (migration `0008` is applied). Leave it running and unchanged while notes are generated.
2. **Admin → Learning material** → tick **one chapter** (e.g. 9 Accounting Ratios) → **Generate**. The button shows the number of notes and the estimate.
3. Open notes from the list: the note (with page references), the code checks (⚠ = look closely), the critic's scores and issues. **Approve** with your score (1–5) or **Reject** with a reason. The Phase 3 exit asks for a reviewer score of 4 or more on a sample.
4. **Comparing models:** set the writer (*Notes, cards, question bank*) and the critic in Admin → AI models, then generate the same chapter again. The new versions replace the older drafts in the list, but the older ones are kept: open a note and use the **Versions** strip to switch between them (older versions are view only). Set the models back afterwards.
5. **Each note has two parts:** *Write this in the exam* (the answer a student writes, sized to the minutes the paper allows; the check `Exam answer fits N min` warns when it is too long) and *Understand it* (read, not memorised). To change a note, type a comment under **Your review** and press **Rewrite with my comment**: it comes back as a new version to review (about a minute; the old draft is marked rejected with your comment). Notes made before `note@2` show the older shape until regenerated.
6. **Cards & memory maps** tab: one set per chapter (a memory map + 8–40 quick cards to memorise). Generate a chapter after its notes (the cards use the notes' summaries and key terms). Review, rewrite and versions work as for notes. **Subject map** tab: chapter weights and most-asked topics, built from the strategy (free).
7. **Question bank** tab: one set per chapter and blueprint part (1-mark sets of 10, 2-mark of 5, 6-mark of 3, 12-mark of 2). Open a set to see each question with its type, difficulty, model answer and marking points. Watch the checks *Not copied from past papers* and *Marking points add up*. Review, rewrite and versions as for notes.
8. **Concept graph** tab: one graph for the subject (which topics to learn first). Generate after the notes (it reads their summaries); check *No cycles* and *Only known topics*.
9. **Teacher review:** sign in to the web app as a teacher who teaches the subject → Teaching → **Review material** → score (1–5) and comment. The Admin sees the scores on each item and the average under the tabs.
10. **On the phone** (`pnpm dev:mobile`, a student enrolled in the subject): Learn → **Chapters** shows only **approved** material; open a chapter (notes, cards, questions), then turn on airplane mode and open it again: it is read from the phone. Practice shows the question bank.
11. **Share with other environments** (top of Learning material): **Publish approved material** puts the approved strategy and every approved item in the shared store as a new version (no model calls). Staging imports it at phase end.
12. When the chapter looks good, generate the rest (untick all = all chapters). A stopped run: **Continue** (notes already written aren't paid again).

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
| Remove leftover test data (`@example.com` accounts, E2E/Smoke colleges, their credits) | `pnpm cleanup-test:local` (runs automatically after `test:e2e`) |
| Upload + read the board material folder (LOCAL only; `--dry-run` shows the plan) | `pnpm upload-board:local --email <admin> --password <pw> --read` |
| Run the hourly job by hand (release stale holds, check charges against OpenRouter); cron doesn't fire under `wrangler dev` | `curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=0+*+*+*+*"` (needs `dev:worker` running) |
| Make a user Admin | `pnpm make-admin:local <email>` |
| Recent dev emails (codes, links) | http://localhost:8787/api/dev/outbox?to=&lt;email&gt; |
| Type-check everything | `pnpm typecheck` |
| Run all tests | `pnpm test` |
| Browser end-to-end tests | `pnpm --filter @aicoach/admin-web test:e2e` |
| Format code | `pnpm format` |
