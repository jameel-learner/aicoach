import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-password-123';
const run = Date.now();
const emails = {
  admin: `e2e.admin.${run}@example.com`,
  poc: `e2e.poc.${run}@example.com`,
  teacher: `e2e.teacher.${run}@example.com`,
};
const workerDir = path.resolve(import.meta.dirname, '../../worker');

async function latestOtp(page: Page, email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const res = await page.request.get(`/api/dev/outbox?to=${encodeURIComponent(email)}`);
    const msgs = (await res.json()) as { tag: string; text: string }[];
    const otp = msgs
      .reverse()
      .find((m) => m.tag === '2fa_otp')
      ?.text.match(/\b(\d{6})\b/)?.[1];
    if (otp) return otp;
    await page.waitForTimeout(500);
  }
  throw new Error(`no OTP for ${email}`);
}

/** Sign-up through the API (captcha test token) so each test focuses on one UI flow. */
async function apiSignUp(page: Page, email: string, name: string, role: 'teacher' | 'student') {
  const res = await page.request.post('/api/auth/sign-up/email', {
    headers: { 'x-captcha-response': 'XXXX.DUMMY.TOKEN.XXXX', origin: 'http://localhost:8787' },
    data: { name, email, password: PASSWORD, role },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function uiSignIn(page: Page, email: string) {
  // Clear any earlier OTPs so we read the fresh one.
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  const button = page.getByRole('button', { name: 'Continue' });
  await expect(button).toBeEnabled(); // Turnstile test key solves automatically
  await button.click();
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  await page.getByLabel('Code').fill(await latestOtp(page, email));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome|Hi / })).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

test('sign up through the UI shows the account-created step', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Full name').fill('E2E Admin');
  await page.getByLabel('Email').fill(emails.admin);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('I am a').selectOption('teacher');
  const create = page.getByRole('button', { name: 'Create account' });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByRole('heading', { name: 'Account created' })).toBeVisible();
});

test('admin → institution → POC → class → class teacher', async ({ page }) => {
  // Promote the account created above to Admin (as an operator would).
  execFileSync(process.execPath, ['scripts/make-admin.mjs', '--local', emails.admin], {
    cwd: workerDir,
    stdio: 'ignore',
  });
  await apiSignUp(page, emails.poc, 'E2E Poc', 'teacher');
  await apiSignUp(page, emails.teacher, 'E2E Teacher', 'teacher');

  // --- Admin creates an institution and assigns the POC
  await uiSignIn(page, emails.admin);
  await page.getByRole('link', { name: 'Institutions' }).first().click();
  const instName = `E2E PU College ${run}`;
  await page.getByLabel('Name').fill(instName);
  await page.getByLabel('City').fill('Mysuru');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const row = page.getByRole('row', { name: new RegExp(instName) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'POCs' }).click();
  await page.getByLabel('Add POC by email').fill(emails.poc);
  await page.getByRole('button', { name: 'Assign POC' }).click();
  await expect(page.getByText(`(${emails.poc})`)).toBeVisible();
  await signOut(page);

  // --- POC creates a class for KSEAB 2nd PUC Accountancy and assigns the class teacher
  await uiSignIn(page, emails.poc);
  await page.getByRole('link', { name: instName }).first().click();
  await page.getByLabel('Subject').selectOption({ label: 'KSEAB · 2nd PUC · Accountancy' });
  await page.getByLabel('Class name').fill('2nd PUC Commerce A');
  await page.getByRole('button', { name: 'Create class' }).click();
  await expect(page.getByRole('link', { name: '2nd PUC Commerce A' })).toBeVisible();
  await page.getByLabel('Class teacher email for 2nd PUC Commerce A').fill(emails.teacher);
  await page.getByRole('button', { name: 'Assign' }).click();
  await expect(page.getByText(emails.teacher).first()).toBeVisible();
  await signOut(page);

  // --- Teacher sees the class
  await uiSignIn(page, emails.teacher);
  await page.getByRole('link', { name: 'My classes' }).first().click();
  await expect(page.getByText('2nd PUC Commerce A')).toBeVisible();
  await expect(page.getByText('Class teacher')).toBeVisible();
  await page.getByText('2nd PUC Commerce A').click();
  await expect(page.getByRole('heading', { name: 'Students' })).toBeVisible();
});

test('a teacher cannot open admin pages (API refuses)', async ({ page }) => {
  await uiSignIn(page, emails.teacher);
  const res = await page.request.get('/api/admin/institutions');
  expect(res.status()).toBe(403);
});
