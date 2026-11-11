#!/usr/bin/env node
// Bulk upload of board exam material to the LOCAL server (architecture §3.5, decision 9.5-2).
//
//   node apps/worker/scripts/upload-board-material.mjs --email <admin> --password <pw> [--dry-run] [--read]
//        [--folder docs/board-material/kseab-2puc-accountancy] [--offering offering_kseab_2puc_accountancy]
//
// Walks <folder>/<category folder>/*.pdf. The category comes from the folder name, the academic year
// from the folder or file name. Board papers are labelled by the academic year of the students who
// sat them (March 2026 exam → 2025-26). "<paper>_Answers.pdf" is uploaded as the scheme of evaluation
// linked to <paper>.pdf. Answer scripts get their cover page (page 1: register number) removed before
// storing. Byte-identical files and already-uploaded titles are skipped, so it can be re-run safely.
//
// --dry-run  only prints the plan, pages and the estimated reading cost (nothing is uploaded).
// --read     after uploading, starts "Read all pages" for each document, one at a time (the reading
//            costs real OpenRouter credit, paid from the platform wallet). Keep the server running.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const BASE = arg('base', 'http://localhost:8787');
const EMAIL = arg('email', process.env.ADMIN_EMAIL);
const PASSWORD = arg('password', process.env.ADMIN_PASSWORD);
const FOLDER = arg('folder', 'docs/board-material/kseab-2puc-accountancy');
const OFFERING = arg('offering', 'offering_kseab_2puc_accountancy');
const DRY = flag('dry-run');
const READ = flag('read');

/** Folder name → category; `year` = fixed academic year, or derived from the file name. */
const FOLDERS = [
  { match: /blueprint/i, category: 'blueprint' },
  { match: /model-question-paper/i, category: 'model_paper' },
  { match: /board-paper/i, category: 'board_paper' },
  { match: /question-bank/i, category: 'question_bank' },
  { match: /scheme-of-evaluation/i, category: 'scheme' },
  { match: /answer-script/i, category: 'answer_script' },
];
/** Content-identical to the 2026-27 blueprint (checked 2026-11-09): not needed (option A). */
const SKIP_FOLDERS = [/^2025-26-blueprints$/];
const LABEL = {
  blueprint: 'Blueprint',
  model_paper: 'Model question paper',
  board_paper: 'Board paper',
  scheme: 'Scheme of evaluation',
  question_bank: 'Question bank',
  answer_script: 'Centum answer script',
};
const COVER_WHY =
  'Cover page of the answer booklet: register number and signatures (personal details), never stored';
const USD_PER_PAGE = { default: 0.0022, answer_script: 0.003 };

const yearOf = (s) => {
  const m = /(20\d\d)\s*[-_]\s*(\d\d)\b/.exec(s);
  return m ? `${m[1]}-${m[2]}` : null;
};
/** Exam year in a file name (e.g. _2026) → academic year of the students (2025-26). */
const examYearToAcademic = (file) => {
  const m = /_(20\d\d)(?:_|\.|$)/.exec(file);
  if (!m) return null;
  const y = Number(m[1]);
  return `${y - 1}-${String(y % 100).padStart(2, '0')}`;
};

const cookies = new Map();
async function call(method, p, body, multipart) {
  const headers = {
    origin: BASE,
    'x-captcha-response': 'XXXX.DUMMY.TOKEN.XXXX',
    cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  };
  if (body !== undefined && !multipart) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: multipart ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    const v = pair.slice(i + 1).trim();
    if (!v || /max-age=0/i.test(line)) cookies.delete(pair.slice(0, i).trim());
    else cookies.set(pair.slice(0, i).trim(), v);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok)
    throw new Error(`${method} ${p} → ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function signIn() {
  const health = await call('GET', '/api/health');
  if (health.env !== 'development')
    throw new Error(
      'Board material is processed on the LOCAL server only (then imported elsewhere)',
    );
  await call('POST', '/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD });
  await call('POST', '/api/auth/two-factor/send-otp', {});
  await new Promise((r) => setTimeout(r, 600));
  const out = await call('GET', `/api/dev/outbox?to=${encodeURIComponent(EMAIL)}`);
  const otp = out
    .reverse()
    .find((m) => m.tag === '2fa_otp')
    ?.text.match(/\b(\d{6})\b/)?.[1];
  if (!otp) throw new Error('No sign-in code in the dev outbox');
  await call('POST', '/api/auth/two-factor/verify-otp', { code: otp });
  const me = await call('GET', '/api/me');
  if (me.user.role !== 'admin') throw new Error('Sign in with an Admin account');
}

/** Page count without a PDF library: count /Type /Page objects (good enough for an estimate). */
const roughPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

/** "2-8, 23-24" → [2..8, 23, 24] */
const pageList = (text) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const [a, b = a] = part.split('-').map((n) => Number(n.trim()));
      if (!a || !b || b < a) throw new Error(`Bad page range "${part}" in pages-to-remove.json`);
      return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    });

/** "1, 2, 3, 7" → "1-3, 7" */
const ranges = (text) =>
  pageList(text)
    .reduce((acc, p) => {
      const last = acc.at(-1);
      if (last && p === last[1] + 1) last[1] = p;
      else acc.push([p, p]);
      return acc;
    }, [])
    .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
    .join(', ');

// Curated list of pages not to upload (Kannada duplicates, blanks, repeated papers), reviewed by the
// user: <folder>/pages-to-remove.json { "<category folder>/<file>": { "remove": "2-8", "why": "…" } }
const removeFile = path.join(FOLDER, 'pages-to-remove.json');
let curated = {};
try {
  curated = JSON.parse(readFileSync(removeFile, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT')
    throw new Error(`Cannot read ${removeFile}: ${err.message}`, { cause: err });
}

// ------------------------------------------------------------------ plan
const docs = [];
const seen = new Map();
for (const dir of readdirSync(FOLDER).sort()) {
  const full = path.join(FOLDER, dir);
  if (!statSync(full).isDirectory()) continue;
  if (SKIP_FOLDERS.some((r) => r.test(dir))) {
    console.log(`skip folder  ${dir} (content-identical to a newer one)`);
    continue;
  }
  const kind = FOLDERS.find((f) => f.match.test(dir));
  if (!kind) {
    console.log(`skip folder  ${dir} (unknown category)`);
    continue;
  }
  for (const file of readdirSync(full)
    .filter((f) => /\.pdf$/i.test(f))
    .sort()) {
    const buf = readFileSync(path.join(full, file));
    const hash = createHash('sha256').update(buf).digest('hex');
    if (seen.has(hash)) {
      console.log(`skip file    ${dir}/${file} (byte-identical to ${seen.get(hash)})`);
      continue;
    }
    seen.set(hash, `${dir}/${file}`);
    const isAnswers = /_answers\.pdf$/i.test(file);
    const category = isAnswers ? 'scheme' : kind.category;
    const byExam = category === 'board_paper' || category === 'answer_script' || isAnswers;
    const academicYear = (byExam ? examYearToAcademic(file) : null) ?? yearOf(file) ?? yearOf(dir);
    if (!academicYear) throw new Error(`No academic year for ${dir}/${file}`);
    // Answer-script cover pages (register number) are always removed; plus the curated list
    // ({ remove: [{ pages, why }] }, or the older { remove: "2-8", why }).
    const entry = curated[`${dir}/${file}`];
    const reasons = [
      ...(category === 'answer_script' ? [{ pages: '1', why: COVER_WHY }] : []),
      ...(Array.isArray(entry?.remove)
        ? entry.remove
        : entry?.remove
          ? [{ pages: entry.remove, why: entry.why ?? 'Removed before upload' }]
          : []),
    ];
    const remove = new Set(reasons.flatMap((r) => pageList(r.pages)));
    const removeList = [...remove].sort((a, b) => a - b);
    docs.push({
      dir,
      file,
      buf,
      category,
      academicYear,
      pairOf: isAnswers ? file.replace(/_answers\.pdf$/i, '.pdf') : null,
      removePages: removeList.join(', '),
      removed: removeList.length,
      reasons,
      pages: roughPages(buf),
      title: `${LABEL[category]} ${academicYear} · ${file.replace(/\.pdf$/i, '')}`,
    });
  }
}
// Papers before their schemes (a scheme links to its paper's id)
docs.sort((a, b) => Number(!!a.pairOf) - Number(!!b.pairOf));

let pagesTotal = 0;
let removedTotal = 0;
let usd = 0;
console.log('\nPlan:');
for (const d of docs) {
  const read = d.pages - d.removed;
  pagesTotal += read;
  removedTotal += d.removed;
  usd += read * (USD_PER_PAGE[d.category] ?? USD_PER_PAGE.default);
  console.log(
    `  ${String(read).padStart(4)} p  ${d.category.padEnd(13)} ${d.academicYear}  ${d.dir}/${d.file}${d.pairOf ? `  → answers for ${d.pairOf}` : ''}${d.removed ? `\n         (removing ${d.removed} of ${d.pages} pages: ${ranges(d.removePages)})` : ''}`,
  );
}
for (const key of Object.keys(curated).filter((k) => !k.startsWith('_')))
  if (!docs.some((d) => `${d.dir}/${d.file}` === key))
    console.log(`  note: pages-to-remove.json lists ${key}, which is not being uploaded`);
console.log(
  `\n${docs.length} documents, ${pagesTotal} pages to read ≈ US$${usd.toFixed(2)} (${removedTotal} pages removed before upload; reading only, analysis comes later)`,
);
if (DRY) process.exit(0);
if (!EMAIL || !PASSWORD) {
  console.error(
    'Usage: node apps/worker/scripts/upload-board-material.mjs --email <admin> --password <pw> [--read]',
  );
  process.exit(1);
}

// ------------------------------------------------------------------ upload
await signIn();
const existing = await call('GET', '/api/admin/books');
const idByFile = new Map();
const uploaded = [];
for (const d of docs) {
  const have = existing.find((b) => b.title === d.title);
  if (have) {
    console.log(`already uploaded  ${d.title}`);
    const same =
      JSON.stringify(have.removedPages ?? []) === JSON.stringify(pageList(d.removePages));
    if (!same)
      console.log(
        `  ! its stored pages were removed differently (${ranges((have.removedPages ?? []).join(','))}); reasons not changed`,
      );
    else if (
      d.reasons.length &&
      JSON.stringify(have.removedReasons) !== JSON.stringify(d.reasons)
    ) {
      // Uploaded before reasons were recorded (or reasons edited): store them now.
      await call('PUT', `/api/admin/books/${have.id}/removed-reasons`, { reasons: d.reasons });
      console.log('  + recorded why its pages were left out');
    }
    idByFile.set(`${d.dir}/${d.file}`, have.id);
    uploaded.push({ ...d, id: have.id });
    continue;
  }
  const form = new FormData();
  form.set('file', new File([d.buf], d.file, { type: 'application/pdf' }));
  form.set('title', d.title);
  form.set('offeringId', OFFERING);
  form.set('kind', 'board_material');
  form.set('category', d.category);
  form.set('academicYear', d.academicYear);
  if (d.removePages) form.set('removePages', d.removePages);
  if (d.reasons.length) form.set('removeReasons', JSON.stringify(d.reasons));
  if (d.pairOf) {
    const paperId = idByFile.get(`${d.dir}/${d.pairOf}`);
    if (paperId) form.set('relatedBookId', paperId);
    else console.log(`  (no paper ${d.pairOf} found to link ${d.file} to)`);
  }
  const res = await call('POST', '/api/admin/books', undefined, form);
  idByFile.set(`${d.dir}/${d.file}`, res.id);
  uploaded.push({ ...d, id: res.id });
  console.log(`uploaded  ${res.pageCount} p  ${d.title}`);
}

// ------------------------------------------------------------------ read (optional)
if (READ) {
  for (const d of uploaded) {
    let view = await call('GET', `/api/admin/books/${d.id}`);
    const left = view.pages.filter((p) => p.status === 'pending' || p.status === 'failed').length;
    if (!left) {
      console.log(`read already  ${d.title}`);
      continue;
    }
    await call('POST', `/api/admin/books/${d.id}/parse`, {});
    process.stdout.write(`reading  ${d.title} `);
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      view = await call('GET', `/api/admin/books/${d.id}`);
      const done = view.pages.filter((p) => p.status !== 'pending').length;
      process.stdout.write(`\rreading  ${d.title}  ${done}/${view.pages.length}   `);
      if (['review', 'failed', 'published'].includes(view.book.status) || view.stalled) break;
    }
    const usdDoc = view.parseCostUsdNano / 1e9;
    console.log(
      `\n  → ${view.book.status}${view.book.statusMessage ? `: ${view.book.statusMessage}` : ''}${view.stalled ? ' (stalled: run it again to continue)' : ''} · US$${usdDoc.toFixed(4)}`,
    );
    if (view.book.status === 'failed' || view.stalled) break;
  }
}
console.log('\nDone. Review the documents under Admin → Textbooks (Board material).');
