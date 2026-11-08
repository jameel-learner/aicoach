import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRegistryCache } from '../src/llm/registry';
import { call, createSignedInUser, json, seedPilotTaxonomy, type Jar } from './helpers';
import { installOpenRouterMock, type MockState } from './openrouter-mock';

const MICRO = 1_000_000; // micro-INR per rupee (1 credit = ₹1)
let or: MockState;

const CREDIT_TABLES = [
  'ledger_entries',
  'allotment_edits',
  'credit_requests',
  'llm_usage',
  'credit_holds',
  'allotments',
  'payments',
  'wallets',
  'model_registry',
  'platform_settings',
];

beforeEach(async () => {
  // Storage persists across tests in a file; the platform wallet (/p) is global, so start clean.
  await env.DB.batch(CREDIT_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  or = installOpenRouterMock();
  clearRegistryCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function walletsOf(jar: Jar) {
  return json<any[]>(await call('GET', '/api/credits/mine', { jar }));
}
async function walletView(jar: Jar, id: string) {
  return call('GET', `/api/credits/wallets/${id}`, { jar });
}

/**
 * admin → institution (POC) → class (teacher) → student, with models synced.
 * Returns wallet ids for each level.
 */
async function buildTree() {
  const offeringId = await seedPilotTaxonomy();
  const admin = await createSignedInUser('admin');
  const poc = await createSignedInUser('institution_poc');
  const teacher = await createSignedInUser('teacher');
  const student = await createSignedInUser('student');
  expect((await call('POST', '/api/admin/models/sync', { jar: admin.jar })).status).toBe(200);

  const inst = await json(
    await call('POST', '/api/admin/institutions', {
      jar: admin.jar,
      body: { name: 'Credit College', type: 'college' },
    }),
  );
  await call('POST', `/api/admin/institutions/${inst.id}/pocs`, {
    jar: admin.jar,
    body: { email: poc.email },
  });
  const cls = await json(
    await call('POST', `/api/institutions/${inst.id}/classes`, {
      jar: poc.jar,
      body: { offeringId, name: '2nd PUC A', academicYear: '2026-27' },
    }),
  );
  await call('PUT', `/api/institutions/${inst.id}/classes/${cls.id}/teacher`, {
    jar: poc.jar,
    body: { email: teacher.email },
  });
  await call('POST', '/api/me/enrolments/join', {
    jar: student.jar,
    body: { joinCode: cls.joinCode },
  });

  const platformW = (await walletsOf(admin.jar))[0];
  const instW = (await walletsOf(poc.jar)).find((w) => w.ownerType === 'institution');
  const classW = (await walletsOf(teacher.jar)).find((w) => w.ownerType === 'class');
  const studentW = (await walletsOf(student.jar)).find(
    (w) => w.ownerType === 'user' && w.label && !w.label.includes('direct'),
  );
  return { admin, poc, teacher, student, inst, cls, platformW, instW, classW, studentW };
}

async function issue(adminJar: Jar, institutionId: string, credits: string) {
  const res = await call('POST', '/api/admin/credits/issue', {
    jar: adminJar,
    body: { target: { type: 'institution', institutionId }, credits },
  });
  expect(res.status).toBe(201);
  return (await json(res)).id as string;
}

async function balanceMicro(id: string) {
  const row = await env.DB.prepare('SELECT balance_micro, held_micro FROM wallets WHERE id = ?')
    .bind(id)
    .first<{ balance_micro: number; held_micro: number }>();
  return row!;
}

describe('allotment lifecycle: allot → (edit) → acknowledge → lock', () => {
  it('flows from Admin to institution to class to student', async () => {
    const t = await buildTree();
    const issuanceId = await issue(t.admin.jar, t.inst.id, '100'); // ₹100
    expect((await balanceMicro(t.instW.id)).balance_micro).toBe(100 * MICRO);
    const mine = (await walletsOf(t.poc.jar)).find((w) => w.id === t.instW.id);
    expect(mine.balanceMicro).toBe(100_000_000); // 100 rupees in micro-INR, not 100 USD

    // POC gives 40 to the class; teacher gives 5 to the student
    const toClass = await call('POST', '/api/credits/allotments', {
      jar: t.poc.jar,
      body: { fromWalletId: t.instW.id, toWalletId: t.classW.id, credits: '40' },
    });
    expect(toClass.status).toBe(201);
    const toStudent = await call('POST', '/api/credits/allotments', {
      jar: t.teacher.jar,
      body: { fromWalletId: t.classW.id, toWalletId: t.studentW.id, credits: '5' },
    });
    expect(toStudent.status).toBe(201);
    expect((await balanceMicro(t.instW.id)).balance_micro).toBe(60 * MICRO);
    expect((await balanceMicro(t.classW.id)).balance_micro).toBe(35 * MICRO);
    expect((await balanceMicro(t.studentW.id)).balance_micro).toBe(5 * MICRO);

    // Cannot give more than you have; cannot skip a level
    expect(
      (
        await call('POST', '/api/credits/allotments', {
          jar: t.teacher.jar,
          body: { fromWalletId: t.classW.id, toWalletId: t.studentW.id, credits: '1000' },
        })
      ).status,
    ).toBe(402);
    expect(
      (
        await call('POST', '/api/credits/allotments', {
          jar: t.poc.jar,
          body: { fromWalletId: t.instW.id, toWalletId: t.studentW.id, credits: '1' },
        })
      ).status,
    ).toBe(400);

    // Lock needs acknowledgement first
    expect(
      (
        await call('POST', `/api/credits/allotments/${issuanceId}/lock`, {
          jar: t.admin.jar,
          body: {},
        })
      ).status,
    ).toBe(409);
    // Only the receiver can acknowledge (not the admin, not the teacher)
    expect(
      (
        await call('POST', `/api/credits/allotments/${issuanceId}/acknowledge`, {
          jar: t.admin.jar,
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/credits/allotments/${issuanceId}/acknowledge`, {
          jar: t.teacher.jar,
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/credits/allotments/${issuanceId}/acknowledge`, {
          jar: t.poc.jar,
          body: {},
        })
      ).status,
    ).toBe(200);

    // Giver edits (typo) → acknowledgement is cleared → lock refused until re-acknowledged
    expect(
      (
        await call('PATCH', `/api/credits/allotments/${issuanceId}`, {
          jar: t.admin.jar,
          body: { credits: '120', reason: 'typo' },
        })
      ).status,
    ).toBe(200);
    expect((await balanceMicro(t.instW.id)).balance_micro).toBe(80 * MICRO);
    expect(
      (
        await call('POST', `/api/credits/allotments/${issuanceId}/lock`, {
          jar: t.admin.jar,
          body: {},
        })
      ).status,
    ).toBe(409);
    // Only the giver edits
    expect(
      (
        await call('PATCH', `/api/credits/allotments/${issuanceId}`, {
          jar: t.poc.jar,
          body: { credits: '500', reason: 'greedy' },
        })
      ).status,
    ).toBe(403);

    await call('POST', `/api/credits/allotments/${issuanceId}/acknowledge`, {
      jar: t.poc.jar,
      body: {},
    });
    expect(
      (
        await call('POST', `/api/credits/allotments/${issuanceId}/lock`, {
          jar: t.admin.jar,
          body: {},
        })
      ).status,
    ).toBe(200);

    // Locked: no edits by anyone
    expect(
      (
        await call('PATCH', `/api/credits/allotments/${issuanceId}`, {
          jar: t.admin.jar,
          body: { credits: '1', reason: 'oops' },
        })
      ).status,
    ).toBe(409);

    // History shows the edit
    const view = await json(await walletView(t.poc.jar, t.instW.id));
    const a = view.allotments.find((x: any) => x.id === issuanceId);
    expect(a.status).toBe('locked');
    expect(a.edits).toEqual([
      expect.objectContaining({
        oldAmountMicro: 100 * MICRO,
        newAmountMicro: 120 * MICRO,
        reason: 'typo',
      }),
    ]);
  });

  it("an edit can't take back credits the receiver already spent", async () => {
    const t = await buildTree();
    await issue(t.admin.jar, t.inst.id, '10');
    const res = await call('POST', '/api/credits/allotments', {
      jar: t.poc.jar,
      body: { fromWalletId: t.instW.id, toWalletId: t.classW.id, credits: '10' },
    });
    const allotId = (await json(res)).id;
    // Class passes 9 down to the student, so only 1 remains in the class wallet
    await call('POST', '/api/credits/allotments', {
      jar: t.teacher.jar,
      body: { fromWalletId: t.classW.id, toWalletId: t.studentW.id, credits: '9' },
    });
    const reduce = await call('PATCH', `/api/credits/allotments/${allotId}`, {
      jar: t.poc.jar,
      body: { credits: '2', reason: 'typo' },
    });
    expect(reduce.status).toBe(402);
    // Nothing changed
    expect((await balanceMicro(t.classW.id)).balance_micro).toBe(1 * MICRO);
    expect((await balanceMicro(t.instW.id)).balance_micro).toBe(0);
    const view = await json(await walletView(t.poc.jar, t.instW.id));
    expect(view.allotments.find((x: any) => x.id === allotId).amountMicro).toBe(10 * MICRO);
  });
});

describe('visibility: own + immediate downline; Admin sees all (decision 6.5)', () => {
  it('enforces the rule per role', async () => {
    const t = await buildTree();
    // POC: institution (own) ✓, class (child) ✓, student (grandchild) ✗, platform (parent) ✗
    expect((await walletView(t.poc.jar, t.instW.id)).status).toBe(200);
    expect((await walletView(t.poc.jar, t.classW.id)).status).toBe(200);
    expect((await walletView(t.poc.jar, t.studentW.id)).status).toBe(403);
    expect((await walletView(t.poc.jar, t.platformW.id)).status).toBe(403);
    // Teacher: class ✓, student ✓, institution ✗
    expect((await walletView(t.teacher.jar, t.classW.id)).status).toBe(200);
    expect((await walletView(t.teacher.jar, t.studentW.id)).status).toBe(200);
    expect((await walletView(t.teacher.jar, t.instW.id)).status).toBe(403);
    // Student: own ✓, class ✗
    expect((await walletView(t.student.jar, t.studentW.id)).status).toBe(200);
    expect((await walletView(t.student.jar, t.classW.id)).status).toBe(403);
    // Admin: everything
    for (const w of [t.platformW, t.instW, t.classW, t.studentW]) {
      expect((await walletView(t.admin.jar, w.id)).status).toBe(200);
    }
    // POC's institution view lists the class as a child; the teacher's class view lists the student
    const instView = await json(await walletView(t.poc.jar, t.instW.id));
    expect(instView.children.map((c: any) => c.id)).toContain(t.classW.id);
    const classView = await json(await walletView(t.teacher.jar, t.classW.id));
    expect(classView.children.map((c: any) => c.id)).toContain(t.studentW.id);
    // Non-admin views never include raw cost or model
    expect(instView.breakdown.byModel).toBeNull();
  });
});

describe('metering: charge = OpenRouter cost (USD) × rate (₹88 default) × 1.10', () => {
  it('charges the class wallet for a teacher, exact to the micro', async () => {
    const t = await buildTree();
    await issue(t.admin.jar, t.inst.id, '1');
    await call('POST', '/api/credits/allotments', {
      jar: t.poc.jar,
      body: { fromWalletId: t.instW.id, toWalletId: t.classW.id, credits: '1' },
    });

    or.costUsd = 0.0001234; // 123_400 nano-USD × 88 × 1.10 = 11_945.12 → 11_945 micro-INR
    const res = await call('POST', '/api/ai/playground', {
      jar: t.teacher.jar,
      body: { prompt: 'hello', classGroupId: t.cls.id },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.billedMicro).toBe(11_945);
    expect(body.rawUsdNano).toBeNull(); // teachers don't see raw cost
    expect(body.model).toBeNull();
    const b = await balanceMicro(t.classW.id);
    expect(b).toEqual({ balance_micro: MICRO - 11_945, held_micro: 0 });
    // The request asked for the default model
    expect(or.requests.at(-1)!.model).toBe('google/gemini-2.5-flash');

    // POC sees the class's consumption in its downline view
    const instView = await json(await walletView(t.poc.jar, t.instW.id));
    expect(instView.children.find((c: any) => c.id === t.classW.id).consumed.totalMicro).toBe(
      11_945,
    );
    expect(instView.wallet.consumed.totalMicro).toBe(11_945); // subtree total
  });

  it('platform (Admin) usage is charged at cost, no fee', async () => {
    const t = await buildTree();
    await call('POST', '/api/admin/credits/issue', {
      jar: t.admin.jar,
      body: { target: { type: 'platform' }, credits: '1' },
    });
    or.costUsd = 0.0002;
    const body = await json(
      await call('POST', '/api/ai/playground', { jar: t.admin.jar, body: { prompt: 'hi' } }),
    );
    expect(body.billedMicro).toBe(17_600); // $0.0002 × 88, no fee
    expect(body.rawUsdNano).toBe(200_000);
    expect(body.model).toBe('google/gemini-2.5-flash');
  });

  it('a gateway cache hit costs nothing', async () => {
    const t = await buildTree();
    await call('POST', '/api/admin/credits/issue', {
      jar: t.admin.jar,
      body: { target: { type: 'platform' }, credits: '1' },
    });
    or.cacheHit = true;
    or.costUsd = 0.5; // the cached body still carries the original cost; must not be charged
    const body = await json(
      await call('POST', '/api/ai/playground', { jar: t.admin.jar, body: { prompt: 'hi' } }),
    );
    expect(body.billedMicro).toBe(0);
    expect(body.cacheHit).toBe(true);
    expect((await balanceMicro(t.platformW.id)).balance_micro).toBe(MICRO);
  });

  it('insufficient credits: refused before calling OpenRouter', async () => {
    const t = await buildTree();
    const before = or.requests.length;
    const res = await call('POST', '/api/ai/playground', {
      jar: t.teacher.jar,
      body: { prompt: 'hi', classGroupId: t.cls.id },
    });
    expect(res.status).toBe(402);
    expect(or.requests.length).toBe(before);
  });

  it('a provider error releases the hold and charges nothing', async () => {
    const t = await buildTree();
    await call('POST', '/api/admin/credits/issue', {
      jar: t.admin.jar,
      body: { target: { type: 'platform' }, credits: '1' },
    });
    or.fail = { status: 500, message: 'upstream down' };
    const res = await call('POST', '/api/ai/playground', {
      jar: t.admin.jar,
      body: { prompt: 'hi' },
    });
    expect(res.status).toBe(502);
    expect(await balanceMicro(t.platformW.id)).toEqual({ balance_micro: MICRO, held_micro: 0 });
    const usage = await env.DB.prepare(
      "SELECT status, billed_micro FROM llm_usage WHERE status = 'error'",
    ).first();
    expect(usage).toMatchObject({ status: 'error', billed_micro: 0 });
  });

  it('50 concurrent calls never overspend the wallet', async () => {
    const t = await buildTree();
    // Enough for only a few worst-case holds (~₹0.107 = 107_000 micro each at 400 max tokens)
    await issue(t.admin.jar, t.inst.id, '0.44');
    await call('POST', '/api/credits/allotments', {
      jar: t.poc.jar,
      body: { fromWalletId: t.instW.id, toWalletId: t.classW.id, credits: '0.44' },
    });
    or.costUsd = 0.0001; // billed $0.0001 × 88 × 1.1 = ₹0.00968 = 9_680 micro each
    or.delayMs = 20;
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        call('POST', '/api/ai/playground', {
          jar: t.teacher.jar,
          body: { prompt: 'q', classGroupId: t.cls.id },
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 402).length;
    expect(ok + refused).toBe(50);
    expect(ok).toBeGreaterThan(0);
    const b = await balanceMicro(t.classW.id);
    expect(b.held_micro).toBe(0);
    expect(ok).toBeLessThan(50);
    expect(b.balance_micro).toBe(440_000 - ok * 9_680);
    expect(b.balance_micro).toBeGreaterThanOrEqual(0);
  });

  it('daily cap set by the giver limits a wallet', async () => {
    const t = await buildTree();
    await issue(t.admin.jar, t.inst.id, '1');
    await call('POST', '/api/credits/allotments', {
      jar: t.poc.jar,
      body: { fromWalletId: t.instW.id, toWalletId: t.classW.id, credits: '1' },
    });
    // The POC (giver of the class wallet) caps it far below one worst-case request
    expect(
      (
        await call('PUT', `/api/credits/wallets/${t.classW.id}/daily-cap`, {
          jar: t.poc.jar,
          body: { credits: '0.0001' },
        })
      ).status,
    ).toBe(200);
    // The teacher can't change their own cap
    expect(
      (
        await call('PUT', `/api/credits/wallets/${t.classW.id}/daily-cap`, {
          jar: t.teacher.jar,
          body: { credits: null },
        })
      ).status,
    ).toBe(403);
    const res = await call('POST', '/api/ai/playground', {
      jar: t.teacher.jar,
      body: { prompt: 'hi', classGroupId: t.cls.id },
    });
    expect(res.status).toBe(402);
    expect((await json(res)).error.message).toMatch(/limit/);
  });
});

describe('ledger invariant', () => {
  it('issued credits = credits still held in wallets + credits charged for usage', async () => {
    const t = await buildTree();
    const issuanceId = await issue(t.admin.jar, t.inst.id, '3');
    await call('PATCH', `/api/credits/allotments/${issuanceId}`, {
      jar: t.admin.jar,
      body: { credits: '2.5', reason: 'typo' },
    });
    await call('POST', '/api/credits/allotments', {
      jar: t.poc.jar,
      body: { fromWalletId: t.instW.id, toWalletId: t.classW.id, credits: '2' },
    });
    await call('POST', '/api/credits/allotments', {
      jar: t.teacher.jar,
      body: { fromWalletId: t.classW.id, toWalletId: t.studentW.id, credits: '0.5' },
    });
    or.costUsd = 0.00037;
    for (let i = 0; i < 3; i++)
      await call('POST', '/api/ai/playground', {
        jar: t.teacher.jar,
        body: { prompt: 'x', classGroupId: t.cls.id },
      });

    const issued = await env.DB.prepare(
      "SELECT coalesce(sum(amount_micro),0) s FROM ledger_entries WHERE type = 'issue' OR (allotment_id IN (SELECT id FROM allotments WHERE from_wallet_id IS NULL) AND type IN ('edit_in','edit_out'))",
    ).first<{ s: number }>();
    const held = await env.DB.prepare(
      'SELECT coalesce(sum(balance_micro),0) s FROM wallets',
    ).first<{
      s: number;
    }>();
    const charged = await env.DB.prepare(
      'SELECT coalesce(sum(-amount_micro),0) s FROM ledger_entries WHERE type = ?',
    )
      .bind('usage')
      .first<{ s: number }>();
    expect(issued!.s).toBe(2.5 * MICRO);
    expect(held!.s + charged!.s).toBe(issued!.s);
    // Every wallet's balance equals the sum of its ledger entries
    const mismatch = await env.DB.prepare(
      'SELECT w.id FROM wallets w LEFT JOIN (SELECT wallet_id, sum(amount_micro) s FROM ledger_entries GROUP BY wallet_id) l ON l.wallet_id = w.id WHERE w.balance_micro != coalesce(l.s, 0)',
    ).all();
    expect(mismatch.results).toEqual([]);
  });
});

describe('model switching (Admin)', () => {
  it('switches a task to another model, validates capabilities, and only admins may do it', async () => {
    const t = await buildTree();
    await call('POST', '/api/admin/credits/issue', {
      jar: t.admin.jar,
      body: { target: { type: 'platform' }, credits: '1' },
    });
    const models = await json(await call('GET', '/api/admin/models', { jar: t.admin.jar }));
    expect(models.models.map((m: any) => m.id).sort()).toEqual([
      'anthropic/claude-haiku-5.5',
      'anthropic/claude-sonnet-5.5',
      'google/gemini-2.5-flash',
      'openai/gpt-4o-mini',
    ]);
    // Only Gemini can do speech-to-text (audio)
    const stt = models.tasks.find((x: any) => x.task === 'speech_to_text');
    expect(stt.options).toEqual(['google/gemini-2.5-flash']);
    expect(
      (
        await call('PUT', '/api/admin/models/registry/speech_to_text', {
          jar: t.admin.jar,
          body: { primaryModel: 'openai/gpt-4o-mini' },
        })
      ).status,
    ).toBe(400);
    // A model that isn't enabled for selection is refused
    expect(
      (
        await call('PUT', '/api/admin/models/registry/playground', {
          jar: t.admin.jar,
          body: { primaryModel: 'some/other-model' },
        })
      ).status,
    ).toBe(400);

    // Switch the playground to GPT-4o mini with Haiku as fallback
    const put = await call('PUT', '/api/admin/models/registry/playground', {
      jar: t.admin.jar,
      body: { primaryModel: 'openai/gpt-4o-mini', fallbackModels: ['anthropic/claude-haiku-5.5'] },
    });
    expect(put.status).toBe(200);
    await call('POST', '/api/ai/playground', { jar: t.admin.jar, body: { prompt: 'hi' } });
    const last = or.requests.at(-1)!;
    expect(last.model).toBe('openai/gpt-4o-mini');
    expect(last.models).toEqual(['openai/gpt-4o-mini', 'anthropic/claude-haiku-5.5']);

    // Non-admins can't touch models
    expect((await call('GET', '/api/admin/models', { jar: t.teacher.jar })).status).toBe(403);
  });
});

describe('admin: payments, fee and float', () => {
  it('records payments and reports whether OpenRouter can cover outstanding credits', async () => {
    const t = await buildTree();
    const pay = await call('POST', '/api/admin/credits/payments', {
      jar: t.admin.jar,
      body: {
        kind: 'credit_purchase',
        payerType: 'institution',
        institutionId: t.inst.id,
        amount: '8350',
        currency: 'INR',
        method: 'upi',
        paidOn: '2026-11-08',
      },
    });
    expect(pay.status).toBe(201);
    const payment = await json(pay);
    expect(payment.amountMinor).toBe(835_000);
    // Onboarding fees don't give credits
    const fee = await json(
      await call('POST', '/api/admin/credits/payments', {
        jar: t.admin.jar,
        body: {
          kind: 'onboarding_fee',
          payerType: 'institution',
          institutionId: t.inst.id,
          amount: '2000',
          currency: 'INR',
          method: 'bank_transfer',
          paidOn: '2026-11-08',
        },
      }),
    );
    expect(
      (
        await call('POST', '/api/admin/credits/issue', {
          jar: t.admin.jar,
          body: {
            target: { type: 'institution', institutionId: t.inst.id },
            credits: '5',
            paymentId: fee.id,
          },
        })
      ).status,
    ).toBe(400);
    await call('POST', '/api/admin/credits/issue', {
      jar: t.admin.jar,
      body: {
        target: { type: 'institution', institutionId: t.inst.id },
        credits: '968',
        paymentId: payment.id,
      },
    });

    // OpenRouter balance $8; outstanding ₹968 cost ₹968 / 1.10 / 88 = $10 at OpenRouter → warning
    or.balanceUsd = { total: 10, used: 2 };
    const float = await json(await call('GET', '/api/admin/credits/float', { jar: t.admin.jar }));
    expect(float.usdInrPaise).toBe(8800);
    expect(float.outstandingUserMicro).toBe(968 * MICRO);
    expect(float.requiredAtOpenRouterUsdNano).toBe(10e9);
    expect(float.openRouter.balanceUsdNano).toBe(8e9);
    expect(float.warning).toBe(true);
    expect(float.shortfallUsdNano).toBe(2e9);

    // Exchange rate: Admin-only, applies to new calls
    expect(
      (await call('PUT', '/api/admin/credits/rate', { jar: t.admin.jar, body: { rate: '90.00' } }))
        .status,
    ).toBe(200);
    expect(
      (await call('PUT', '/api/admin/credits/rate', { jar: t.poc.jar, body: { rate: '1.00' } }))
        .status,
    ).toBe(403);
    await call('POST', '/api/admin/credits/issue', {
      jar: t.admin.jar,
      body: { target: { type: 'platform' }, credits: '1' },
    });
    or.costUsd = 0.0002;
    const r = await json(
      await call('POST', '/api/ai/playground', { jar: t.admin.jar, body: { prompt: 'hi' } }),
    );
    expect(r.billedMicro).toBe(18_000); // $0.0002 × 90

    // Fee is configurable by admin only
    expect(
      (await call('PUT', '/api/admin/credits/fee', { jar: t.admin.jar, body: { feeBps: 1500 } }))
        .status,
    ).toBe(200);
    expect(
      (await json(await call('GET', '/api/admin/credits/fee', { jar: t.admin.jar }))).feeBps,
    ).toBe(1500);
    expect(
      (await call('PUT', '/api/admin/credits/fee', { jar: t.poc.jar, body: { feeBps: 0 } })).status,
    ).toBe(403);
  });
});

describe('credit requests (decision 9.3-1)', () => {
  async function requests(jar: Jar, scope: 'mine' | 'inbox') {
    return json<any[]>(await call('GET', `/api/credits/requests?scope=${scope}`, { jar }));
  }

  it('student → teacher: accept (auto-allotment) or reject with a comment', async () => {
    const t = await buildTree();
    await issue(t.admin.jar, t.inst.id, '10');
    await call('POST', '/api/credits/allotments', {
      jar: t.poc.jar,
      body: { fromWalletId: t.instW.id, toWalletId: t.classW.id, credits: '10' },
    });
    const mine = await walletsOf(t.student.jar);
    expect(mine.find((w) => w.id === t.studentW.id).requestTo).toMatchObject({ toAdmin: false });

    const res = await call('POST', '/api/credits/requests', {
      jar: t.student.jar,
      body: { walletId: t.studentW.id, credits: '2', message: 'for revision' },
    });
    expect(res.status).toBe(201);
    expect((await json(res)).toAdmin).toBe(false);
    // One pending request per wallet
    expect(
      (
        await call('POST', '/api/credits/requests', {
          jar: t.student.jar,
          body: { walletId: t.studentW.id, credits: '1' },
        })
      ).status,
    ).toBe(409);

    // The teacher sees it; the POC (two levels up) doesn't
    const inbox = await requests(t.teacher.jar, 'inbox');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ amountMicro: 2 * MICRO, message: 'for revision' });
    expect(inbox[0].can.decide).toBe(true);
    expect(await requests(t.poc.jar, 'inbox')).toHaveLength(0);
    // The student can't approve their own request
    expect(
      (
        await call('POST', `/api/credits/requests/${inbox[0].id}/decide`, {
          jar: t.student.jar,
          body: { decision: 'approve' },
        })
      ).status,
    ).toBe(403);

    // Teacher accepts a different amount
    const ok = await call('POST', `/api/credits/requests/${inbox[0].id}/decide`, {
      jar: t.teacher.jar,
      body: { decision: 'approve', credits: '1.5', note: 'Half now' },
    });
    expect(ok.status).toBe(200);
    expect((await balanceMicro(t.studentW.id)).balance_micro).toBe(1.5 * MICRO);
    expect((await balanceMicro(t.classW.id)).balance_micro).toBe(8.5 * MICRO);
    let back = (await requests(t.student.jar, 'mine'))[0];
    expect(back).toMatchObject({
      status: 'approved',
      grantedMicro: 1.5 * MICRO,
      decisionNote: 'Half now',
    });
    // Deciding twice is refused
    expect(
      (
        await call('POST', `/api/credits/requests/${inbox[0].id}/decide`, {
          jar: t.teacher.jar,
          body: { decision: 'approve' },
        })
      ).status,
    ).toBe(409);
    // The allotment follows the normal lifecycle (receiver confirms)
    const sv = await json(await walletView(t.student.jar, t.studentW.id));
    expect(sv.allotments[0].can.acknowledge).toBe(true);

    // Reject needs a comment, which the student sees
    const second = await json(
      await call('POST', '/api/credits/requests', {
        jar: t.student.jar,
        body: { walletId: t.studentW.id, credits: '50' },
      }),
    );
    expect(
      (
        await call('POST', `/api/credits/requests/${second.id}/decide`, {
          jar: t.teacher.jar,
          body: { decision: 'reject' },
        })
      ).status,
    ).toBe(400);
    // Approving more than the class has fails and leaves the request pending
    expect(
      (
        await call('POST', `/api/credits/requests/${second.id}/decide`, {
          jar: t.teacher.jar,
          body: { decision: 'approve' },
        })
      ).status,
    ).toBe(402);
    expect((await requests(t.teacher.jar, 'inbox'))[0].status).toBe('pending');
    await call('POST', `/api/credits/requests/${second.id}/decide`, {
      jar: t.teacher.jar,
      body: { decision: 'reject', note: 'Too much for one week' },
    });
    back = (await requests(t.student.jar, 'mine'))[0];
    expect(back).toMatchObject({ status: 'rejected', decisionNote: 'Too much for one week' });
    expect((await balanceMicro(t.studentW.id)).balance_micro).toBe(1.5 * MICRO);
  });

  it('requests to Admin carry a UTR, create a pending payment, and issue on confirmation', async () => {
    const t = await buildTree();
    const instMine = (await walletsOf(t.poc.jar)).find((w) => w.id === t.instW.id);
    expect(instMine.requestTo).toMatchObject({ toAdmin: true });

    // UTR is mandatory for Admin-bound requests
    expect(
      (
        await call('POST', '/api/credits/requests', {
          jar: t.poc.jar,
          body: { walletId: t.instW.id, credits: '8350' },
        })
      ).status,
    ).toBe(400);
    const res = await call('POST', '/api/credits/requests', {
      jar: t.poc.jar,
      body: {
        walletId: t.instW.id,
        credits: '8350',
        payment: { reference: '412345678901', method: 'upi', paidOn: '2026-11-08' },
      },
    });
    expect(res.status).toBe(201);
    const reqId = (await json(res)).id;

    // A pending payment record exists; it can't be used for a manual issue until verified
    const pays = await json<any[]>(
      await call('GET', '/api/admin/credits/payments', { jar: t.admin.jar }),
    );
    expect(pays[0]).toMatchObject({
      status: 'pending',
      reference: '412345678901',
      amountMinor: 835_000,
      institutionId: t.inst.id,
    });
    expect(
      (
        await call('POST', '/api/admin/credits/issue', {
          jar: t.admin.jar,
          body: {
            target: { type: 'institution', institutionId: t.inst.id },
            credits: '8350',
            paymentId: pays[0].id,
          },
        })
      ).status,
    ).toBe(409);

    // The same UTR can't be claimed twice (teacher's direct wallet)
    const dup = await call('POST', '/api/credits/requests', {
      jar: t.teacher.jar,
      body: {
        credits: '100',
        payment: { reference: '412345678901', method: 'upi', paidOn: '2026-11-08' },
      },
    });
    expect(dup.status).toBe(409);

    // Only Admin decides; Admin's inbox lists it with the payment
    const inbox = await requests(t.admin.jar, 'inbox');
    expect(inbox.find((r) => r.id === reqId).payment).toMatchObject({
      reference: '412345678901',
      status: 'pending',
    });
    expect(
      (
        await call('POST', `/api/credits/requests/${reqId}/decide`, {
          jar: t.poc.jar,
          body: { decision: 'approve' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/credits/requests/${reqId}/decide`, {
          jar: t.admin.jar,
          body: { decision: 'approve' },
        })
      ).status,
    ).toBe(200);
    expect((await balanceMicro(t.instW.id)).balance_micro).toBe(8350 * MICRO);
    const after = await json<any[]>(
      await call('GET', '/api/admin/credits/payments', { jar: t.admin.jar }),
    );
    expect(after.find((p) => p.id === pays[0].id).status).toBe('verified');
    const view = await json(await walletView(t.poc.jar, t.instW.id));
    expect(view.allotments[0]).toMatchObject({ paymentId: pays[0].id, amountMicro: 8350 * MICRO });

    // Teacher's direct wallet: Admin rejects with a comment → payment rejected, UTR reusable
    const direct = await json(
      await call('POST', '/api/credits/requests', {
        jar: t.teacher.jar,
        body: {
          credits: '500',
          payment: { reference: 'N123456789012', method: 'bank_transfer', paidOn: '2026-11-08' },
        },
      }),
    );
    expect(direct.toAdmin).toBe(true);
    await call('POST', `/api/credits/requests/${direct.id}/decide`, {
      jar: t.admin.jar,
      body: { decision: 'reject', note: 'No such credit in our bank statement' },
    });
    const tMine = (await requests(t.teacher.jar, 'mine'))[0];
    expect(tMine).toMatchObject({
      status: 'rejected',
      decisionNote: 'No such credit in our bank statement',
    });
    expect(tMine.payment.status).toBe('rejected');
    expect(
      (
        await call('POST', '/api/credits/requests', {
          jar: t.teacher.jar,
          body: {
            credits: '500',
            payment: { reference: 'N123456789012', method: 'bank_transfer', paidOn: '2026-11-09' },
          },
        })
      ).status,
    ).toBe(201);
    // The requester can cancel while pending
    const pending = (await requests(t.teacher.jar, 'mine')).find((r) => r.status === 'pending');
    expect(
      (
        await call('POST', `/api/credits/requests/${pending.id}/cancel`, {
          jar: t.teacher.jar,
          body: {},
        })
      ).status,
    ).toBe(200);
  });
});

describe('change of class teacher (decision 9.3-4)', () => {
  it("returns the class's unused credits to the institution; personal and student credits stay", async () => {
    const t = await buildTree();
    const newTeacher = await createSignedInUser('teacher');
    const outsider = await createSignedInUser('teacher');
    await issue(t.admin.jar, t.inst.id, '100');
    await call('POST', '/api/credits/allotments', {
      jar: t.poc.jar,
      body: { fromWalletId: t.instW.id, toWalletId: t.classW.id, credits: '40' },
    });
    await call('POST', '/api/credits/allotments', {
      jar: t.teacher.jar,
      body: { fromWalletId: t.classW.id, toWalletId: t.studentW.id, credits: '5' },
    });
    // The teacher's own (direct) wallet, bought from Admin
    const directW = (await walletsOf(t.teacher.jar)).find(
      (w) => w.ownerType === 'user' && w.label.includes('direct'),
    );
    await call('POST', '/api/admin/credits/issue', {
      jar: t.admin.jar,
      body: { target: { type: 'user', email: t.teacher.email }, credits: '20' },
    });
    // A pending request from the class to the POC
    await call('POST', '/api/credits/requests', {
      jar: t.teacher.jar,
      body: { walletId: t.classW.id, credits: '10' },
    });

    const path = `/api/institutions/${t.inst.id}/classes/${t.cls.id}/teacher`;
    // Only Admin / POC can reassign
    expect(
      (await call('PUT', path, { jar: outsider.jar, body: { email: newTeacher.email } })).status,
    ).toBe(403);
    const res = await call('PUT', path, { jar: t.poc.jar, body: { email: newTeacher.email } });
    expect(res.status).toBe(200);
    expect((await json(res)).returnedMicro).toBe(35 * MICRO);

    // ₹35 back with the institution; class empty; student and teacher's own credits untouched
    expect((await balanceMicro(t.instW.id)).balance_micro).toBe(95 * MICRO);
    expect((await balanceMicro(t.classW.id)).balance_micro).toBe(0);
    expect((await balanceMicro(t.studentW.id)).balance_micro).toBe(5 * MICRO);
    expect((await balanceMicro(directW.id)).balance_micro).toBe(20 * MICRO);

    // Both sides see the return in their history (locked)
    const instView = await json(await walletView(t.poc.jar, t.instW.id));
    expect(instView.allotments[0]).toMatchObject({
      direction: 'in',
      amountMicro: 35 * MICRO,
      status: 'locked',
    });

    // Old teacher: no longer manages the class wallet, class gone from their list; own wallet stays
    expect((await walletView(t.teacher.jar, t.classW.id)).status).toBe(403);
    const oldMine = await walletsOf(t.teacher.jar);
    expect(oldMine.some((w) => w.id === t.classW.id)).toBe(false);
    expect(oldMine.some((w) => w.id === directW.id)).toBe(true);
    const oldClasses = await json<any[]>(
      await call('GET', '/api/teacher/classes', { jar: t.teacher.jar }),
    );
    expect(oldClasses.some((c) => c.id === t.cls.id)).toBe(false);
    // Their pending request for the class was cancelled
    const req = (
      await json<any[]>(
        await call('GET', '/api/credits/requests?scope=mine', { jar: t.teacher.jar }),
      )
    ).find((r) => r.wallet.id === t.classW.id);
    expect(req).toMatchObject({ status: 'cancelled', decisionNote: 'Class teacher changed' });

    // New teacher manages the class wallet (₹0) and can receive a fresh allotment
    expect((await walletView(newTeacher.jar, t.classW.id)).status).toBe(200);
    expect(
      (
        await call('POST', '/api/credits/allotments', {
          jar: t.poc.jar,
          body: { fromWalletId: t.instW.id, toWalletId: t.classW.id, credits: '10' },
        })
      ).status,
    ).toBe(201);

    // Admin can reassign back; nothing left over is lost and the ledger still balances
    expect(
      (await call('PUT', path, { jar: t.admin.jar, body: { email: t.teacher.email } })).status,
    ).toBe(200);
    expect((await balanceMicro(t.instW.id)).balance_micro).toBe(95 * MICRO);
    expect((await walletView(t.teacher.jar, t.classW.id)).status).toBe(200);
    const mismatch = await env.DB.prepare(
      'SELECT w.id FROM wallets w LEFT JOIN (SELECT wallet_id, sum(amount_micro) s FROM ledger_entries GROUP BY wallet_id) l ON l.wallet_id = w.id WHERE w.balance_micro != coalesce(l.s, 0)',
    ).all();
    expect(mismatch.results).toEqual([]);
  });
});
