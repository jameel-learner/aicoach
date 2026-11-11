#!/usr/bin/env node
// Eval harness v1 (architecture §6.3, §7 Phase 2). Runs the golden set against the LOCAL server.
//
//   node evals/run.mjs --email you@example.com --password '...' [--model anthropic/claude-haiku-5.5]
//                      [--golden evals/golden/ncert-accountancy.jsonl] [--limit 10] [--base http://localhost:8787]
//
// Signs in as an Admin (sign-in code read from the dev outbox: LOCAL only), asks every question with
// a fresh answer (no cache), scores:
//   citation accuracy: the answer cites a page in expectedPages (±1) of the right book
//                      (for "not in textbook" items: the answer says so)
//   correctness:       LLM judge (task eval_judge) vs the reference answer: 0 / 0.5 / 1
// and stores the run so the Admin Models screen shows the scores. Costs real OpenRouter credit
// (about US$0.03 for 55 questions with gemini-2.5-flash), paid from the platform wallet.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const BASE = arg('base', 'http://localhost:8787');
const EMAIL = arg('email', process.env.EVAL_EMAIL);
const PASSWORD = arg('password', process.env.EVAL_PASSWORD);
const MODEL = arg('model');
const LIMIT = Number(arg('limit', '0'));
const GOLDEN = arg('golden', path.join(import.meta.dirname, 'golden', 'ncert-accountancy.jsonl'));
if (!EMAIL || !PASSWORD) {
  console.error(
    'Usage: node evals/run.mjs --email <admin email> --password <password> [--model <slug>]',
  );
  process.exit(1);
}

const cookies = new Map();
async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      origin: BASE,
      'x-captcha-response': 'XXXX.DUMMY.TOKEN.XXXX',
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  if (health.env !== 'development') throw new Error('Evals run against the LOCAL server only');
  await call('POST', '/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD });
  await call('POST', '/api/auth/two-factor/send-otp', {});
  await new Promise((r) => setTimeout(r, 500));
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

/** 1 / 2 for "Part I" / "Part 1" / "Part II" / "Part 2" titles, else 0. */
const bookNo = (title) =>
  /\bPart\s*(II|2)\b/i.test(title) ? 2 : /\bPart\s*(I|1)\b/i.test(title) ? 1 : 0;

function citationHit(item, res) {
  if (item.expectNotInBook) return res.notInBook ? 1 : 0;
  if (res.notInBook) return 0;
  return res.citations.some(
    (c) =>
      (!item.book || bookNo(c.bookTitle) === item.book) &&
      item.expectedPages.some((p) => Math.abs(p - c.page) <= 1),
  )
    ? 1
    : 0;
}

const golden = readFileSync(GOLDEN, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
await signIn();
// Only score questions whose book is published here (e.g. before Part II is uploaded).
const scope = await call('GET', '/api/ask/scope');
const published = new Set(scope.books.map((b) => bookNo(b.title)));
console.log(`Books searched: ${scope.books.map((b) => b.title).join(', ') || 'none'}`);
const inScope = golden.filter((g) => !g.book || published.has(g.book));
const skipped = golden.length - inScope.length;
if (skipped)
  console.log(`Skipping ${skipped} question(s) for books that are not published here yet.`);
const items = LIMIT ? inScope.slice(0, LIMIT) : inScope;
console.log(
  `Running ${items.length} questions${MODEL ? ` with ${MODEL}` : ' with the registry tutor model'}…`,
);
const details = [];
let model = MODEL ?? null;
for (const [i, item] of items.entries()) {
  const t0 = Date.now();
  let res;
  try {
    res = await call('POST', '/api/ask', {
      question: item.question,
      stream: false,
      forceNew: true,
      model: MODEL,
    });
  } catch (err) {
    details.push({ id: item.id, error: String(err.message ?? err) });
    console.log(`${String(i + 1).padStart(2)} ${item.id}  ERROR ${err.message}`);
    continue;
  }
  model ??= res.model;
  const cite = citationHit(item, res);
  let correct = item.expectNotInBook ? (res.notInBook ? 1 : 0) : 0;
  let reason = '';
  if (!item.expectNotInBook && !res.notInBook) {
    const j = await call('POST', '/api/admin/evals/judge', {
      question: item.question,
      reference: item.reference,
      answer: res.answer,
    });
    correct = j.score;
    reason = j.reason;
  }
  details.push({
    id: item.id,
    type: item.type ?? (item.expectNotInBook ? 'not_in_book' : 'concept'),
    citation: cite,
    correctness: correct,
    pages: res.citations.map((c) => `${bookNo(c.bookTitle)}:${c.page}`),
    notInBook: res.notInBook,
    uncertain: res.uncertain,
    ms: Date.now() - t0,
    reason,
  });
  console.log(
    `${String(i + 1).padStart(2)} ${item.id.padEnd(6)} cite ${cite ? '✓' : '✗'}  correct ${String(correct).padEnd(3)} pages [${res.citations.map((c) => c.page).join(',')}] expected [${item.expectedPages ?? 'not in book'}]`,
  );
}

const scored = details.filter((d) => d.error === undefined);
const avg = (k) => (scored.length ? scored.reduce((s, d) => s + d[k], 0) / scored.length : 0);
// Per question type (concept, journal, table, figure, formula, not_in_book): where retrieval is weak.
const byType = {};
for (const d of scored) {
  const t = (byType[d.type] ??= { questions: 0, citation: 0, correctness: 0 });
  t.questions++;
  t.citation += d.citation;
  t.correctness += d.correctness;
}
for (const t of Object.values(byType)) {
  t.citation = Math.round((t.citation / t.questions) * 1000) / 1000;
  t.correctness = Math.round((t.correctness / t.questions) * 1000) / 1000;
}
const summary = {
  model: model ?? 'unknown',
  promptVersion: 'tutor_answer@1',
  questions: scored.length,
  citationAccuracy: avg('citation'),
  correctness: avg('correctness'),
  notes: `${path.basename(GOLDEN)}; ${details.length - scored.length} errors; ${skipped} skipped (book not published)`,
  byType,
  details,
};
console.log(
  `\nCitation accuracy ${(summary.citationAccuracy * 100).toFixed(1)}% (target ≥ 90%) · correctness ${(summary.correctness * 100).toFixed(1)}% (target ≥ 85%) · ${scored.length} questions`,
);
for (const [t, v] of Object.entries(byType))
  console.log(
    `  ${t.padEnd(12)} ${String(v.questions).padStart(3)} questions · citation ${(v.citation * 100).toFixed(0)}% · correctness ${(v.correctness * 100).toFixed(0)}%`,
  );
await call('POST', '/api/admin/evals/runs', summary);
const outDir = path.join(import.meta.dirname, 'results');
mkdirSync(outDir, { recursive: true });
const file = path.join(
  outDir,
  `${new Date().toISOString().replace(/[:.]/g, '-')}-${summary.model.replace(/\//g, '_')}.json`,
);
writeFileSync(file, JSON.stringify(summary, null, 2));
console.log(`Saved ${file} and stored the run (Admin → AI models shows it).`);
