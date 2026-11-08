import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 1 UI: Admin records a payment, issues credits, POC confirms + gives to a class, Admin
 * syncs models and uses the playground (real OpenRouter call through the local dev server, ~$0.00002).
 * Then the teacher requests credits from the POC, who accepts (decision 9.3-1). All amounts in ₹.
 */
const PASSWORD = 'e2e-password-123';
const run = Date.now();
const admin = `e2e.cadmin.${run}@example.com`;
const poc = `e2e.cpoc.${run}@example.com`;
const teacher = `e2e.cteacher.${run}@example.com`;
const teacher2 = `e2e.cteacher2.${run}@example.com`;
const workerDir = path.resolve(import.meta.dirname, '../../worker');
const instName = `Credit E2E College ${run}`;

async function lastOtp(page: Page, email: string) {
  const msgs = (await (
    await page.request.get(`/api/dev/outbox?to=${encodeURIComponent(email)}`)
  ).json()) as { tag: string; text: string }[];
  return msgs
    .filter((m) => m.tag === '2fa_otp')
    .at(-1)
    ?.text.match(/\b(\d{6})\b/)?.[1];
}
/** Waits for a code other than `previous` (a user may sign in more than once per test). */
async function newOtp(page: Page, email: string, previous: string | undefined) {
  for (let i = 0; i < 20; i++) {
    const otp = await lastOtp(page, email);
    if (otp && otp !== previous) return otp;
    await page.waitForTimeout(500);
  }
  throw new Error('no otp');
}
async function apiSignUp(page: Page, email: string) {
  const res = await page.request.post('/api/auth/sign-up/email', {
    headers: { 'x-captcha-response': 'XXXX.DUMMY.TOKEN.XXXX', origin: 'http://localhost:8787' },
    data: { name: email.split('@')[0], email, password: PASSWORD, role: 'teacher' },
  });
  expect(res.ok()).toBeTruthy();
}
async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  const previous = await lastOtp(page, email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Code').fill(await newOtp(page, email, previous));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

test('credits flow through the UI', async ({ page }) => {
  // Test data (colleges, ₹ credits) must only ever be created on LOCAL, never on staging/production.
  const health = (await (await page.request.get('/api/health')).json()) as { env: string };
  expect(health.env, 'E2E tests create test colleges and credits: LOCAL only').toBe('development');

  for (const e of [admin, poc, teacher, teacher2]) await apiSignUp(page, e);
  execFileSync(process.execPath, ['scripts/make-admin.mjs', '--local', admin], {
    cwd: workerDir,
    stdio: 'ignore',
  });

  // --- Admin: institution + POC (Phase 0 screens)
  await signIn(page, admin);
  await page.getByRole('link', { name: 'Institutions' }).first().click();
  await page.getByLabel('Name').fill(instName);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page
    .getByRole('row', { name: new RegExp(instName) })
    .getByRole('button', { name: 'POCs' })
    .click();
  await page.getByLabel('Add POC by email').fill(poc);
  await page.getByRole('button', { name: 'Assign POC' }).click();
  await expect(page.getByText(`(${poc})`)).toBeVisible();

  // --- Admin: AI models page + sync
  await page.getByRole('link', { name: 'AI models' }).click();
  await page.getByRole('button', { name: 'Sync from OpenRouter' }).click();
  await expect(page.getByText(/Synced \d+ models/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('cell', { name: /google\/gemini-2\.5-flash/ }).first()).toBeVisible();
  await expect(page.getByLabel('Model for Voice input')).toHaveValue('google/gemini-2.5-flash');

  // --- Admin: record payment → issue credits (form pre-filled)
  await page.getByRole('link', { name: 'Credits & payments' }).click();
  await page.getByLabel('Institution', { exact: true }).first().selectOption({ label: instName });
  await page.getByLabel('Amount', { exact: true }).fill('8350');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByRole('cell', { name: instName }).first()).toBeVisible();
  // 1 credit = ₹1: the amount is pre-filled from the payment
  await expect(page.getByLabel('Amount (₹)')).toHaveValue('8350');
  await page.getByLabel('Amount (₹)').fill('100');
  await page.getByRole('button', { name: 'Issue credits' }).click();
  await expect(page.getByLabel('Amount (₹)')).toHaveValue(''); // issued (form resets)
  // ₹100, not US$100 (1 credit = ₹1)
  await expect(
    page.getByRole('row', { name: new RegExp(instName) }).filter({ hasText: '₹100.00' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: instName })).toBeVisible();

  // --- Admin: platform top-up for own use, then the playground
  await page.getByLabel('To', { exact: true }).selectOption('platform');
  await page.getByLabel('Amount (₹)').fill('5');
  await page.getByRole('button', { name: 'Issue credits' }).click();
  await expect(page.getByLabel('Amount (₹)')).toHaveValue(''); // issued (form resets)
  await page.getByRole('link', { name: 'AI playground' }).click();
  await page.getByLabel('Prompt').fill('Reply with exactly one word: hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('heading', { name: 'Answer' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('google/gemini-2.5-flash')).toBeVisible();
  await signOut(page);

  // --- POC: confirm received, create class, give credits to it
  await signIn(page, poc);
  await page.getByRole('link', { name: instName }).first().click();
  await page.getByLabel('Subject').selectOption({ label: 'KSEAB · 2nd PUC · Accountancy' });
  await page.getByLabel('Class name').fill('Credits Class');
  await page.getByRole('button', { name: 'Create class' }).click();
  await page.getByLabel('Class teacher email for Credits Class').fill(teacher);
  await page.getByRole('button', { name: 'Assign' }).click();
  await expect(page.getByText(teacher).first()).toBeVisible();

  await page.getByRole('link', { name: 'Credits', exact: true }).click();
  await expect(page.getByText('1 to confirm')).toBeVisible();
  await page
    .getByRole('main')
    .getByRole('link', { name: new RegExp(instName) })
    .click();
  await expect(page.getByText('Waiting for receiver')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm received' }).click();
  await expect(page.getByText('Confirmed by receiver')).toBeVisible();
  await page.getByLabel('Amount for Credits Class').fill('25');
  await page.getByRole('button', { name: 'Give' }).click();
  await expect(page.getByText('−₹25.00')).toBeVisible();
  await signOut(page);

  // --- Teacher: sees the class wallet with 25 credits
  await signIn(page, teacher);
  await page.getByRole('link', { name: 'Credits', exact: true }).click();
  await expect(page.getByRole('main').getByRole('link', { name: /Credits Class/ })).toContainText(
    '₹25.00',
  );
  // No fee or dollar wording anywhere a non-Admin looks
  await expect(page.getByText(/US\$|10%|fee/)).toHaveCount(0);

  // --- Teacher asks the POC for more credits
  await page
    .getByRole('main')
    .getByRole('link', { name: /Credits Class/ })
    .click();
  await page.getByLabel('Amount (₹)').fill('10');
  await page.getByLabel('Message (optional)').fill('Mock exam week');
  await page.getByRole('button', { name: 'Request credits' }).click();
  await expect(page.getByText('Waiting for reply')).toBeVisible();
  await signOut(page);

  // --- POC sees the request on the Credits page and accepts a smaller amount
  await signIn(page, poc);
  await page.getByRole('link', { name: 'Credits', exact: true }).click();
  await expect(page.getByText('Credit requests waiting for you')).toBeVisible();
  await expect(page.getByText('“Mock exam week”')).toBeVisible();
  await page.getByLabel('Amount for Credits Class').fill('8');
  await page.getByLabel('Comment for Credits Class').fill('8 for now');
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('Credit requests waiting for you')).toBeHidden();
  await signOut(page);

  // --- Teacher sees the reply and the new balance
  await signIn(page, teacher);
  await page.getByRole('link', { name: 'Credits', exact: true }).click();
  await expect(page.getByRole('main').getByRole('link', { name: /Credits Class/ })).toContainText(
    '₹33.00',
  );
  await page
    .getByRole('main')
    .getByRole('link', { name: /Credits Class/ })
    .click();
  await expect(page.getByText('Accepted')).toBeVisible();
  await expect(page.getByText('“8 for now”')).toBeVisible();

  // --- Teacher buys credits for themself from AI Coach (pays offline, shares the UTR)
  const utr = `E2E${run}`;
  await page.goto('/credits');
  await page.getByRole('link', { name: /Buy credits/ }).click();
  await expect(page.getByText('Buy credits from AI Coach')).toBeVisible();
  await page.getByLabel('Amount paid (₹)').fill('200');
  await page.getByLabel('UTR / transaction reference').fill(utr);
  await page.getByRole('button', { name: 'Submit payment' }).click();
  await expect(page.getByText('Waiting for reply')).toBeVisible();
  await signOut(page);

  // --- Admin verifies the UTR and confirms: payment verified, ₹200 issued to the teacher
  await signIn(page, admin);
  await page.goto('/admin/credits');
  const toVerify = page.getByRole('row', { name: new RegExp(utr) }).first();
  await expect(toVerify).toContainText(teacher);
  await toVerify.getByRole('button', { name: 'Confirm & issue' }).click();
  await expect(
    page.getByRole('row', { name: new RegExp(utr) }).filter({ hasText: 'Verified' }),
  ).toBeVisible();
  await signOut(page);

  await signIn(page, teacher);
  await page.getByRole('link', { name: 'Credits', exact: true }).click();
  await expect(page.getByRole('link', { name: /Buy credits/ })).toContainText('₹200.00');

  // --- POC changes the class teacher: the class's unused ₹33 returns to the institution
  await signOut(page);
  await signIn(page, poc);
  await page.getByRole('link', { name: instName }).first().click();
  await page.getByRole('button', { name: 'Change class teacher of Credits Class' }).click();
  await page.getByLabel('Class teacher email for Credits Class').fill(teacher2);
  await page.getByRole('button', { name: 'Reassign' }).click();
  await expect(page.getByRole('status')).toContainText(
    '₹33.00 of unused class credits returned to the institution',
  );
  await expect(page.getByText(teacher2).first()).toBeVisible();
});
