// Remove data created by automated tests (E2E / smoke) from the LOCAL database.
// Usage: node scripts/cleanup-test-data.mjs --local      (also runs after `pnpm test:e2e`)
//
// Test data is recognised by:
//   - users with an @example.com email (all test accounts use it; real people never do)
//   - institutions named "Credit E2E College <n>", "E2E PU College <n>" or "Smoke College <n>"
// Everything hanging off them is removed: classes, enrolments, POC links, consents, sessions,
// wallets, payments, allotments, ledger entries, usage, holds and credit requests. Credits that
// test admins issued to or spent from the shared platform wallet are removed too, and the platform
// wallet's balance is recomputed from its remaining ledger entries.
//
// LOCAL only: refuses to touch staging or production.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

if (
  !process.argv.includes('--local') ||
  process.argv.includes('--remote') ||
  process.argv.includes('--env')
) {
  console.error('cleanup-test-data only runs against the LOCAL database: pass --local');
  process.exit(1);
}

const TU = `(SELECT id FROM user WHERE email LIKE '%@example.com')`;
const TI = `(SELECT id FROM institutions WHERE name GLOB 'Credit E2E College [0-9]*' OR name GLOB 'E2E PU College [0-9]*' OR name GLOB 'Smoke College [0-9]*')`;
const TC = `(SELECT id FROM class_groups WHERE institution_id IN ${TI})`;
const TW = `(SELECT id FROM wallets WHERE user_id IN ${TU} OR institution_id IN ${TI} OR class_group_id IN ${TC})`;
const TA = `(SELECT id FROM allotments WHERE to_wallet_id IN ${TW} OR from_wallet_id IN ${TW} OR created_by IN ${TU})`;
const TUSAGE = `(SELECT id FROM llm_usage WHERE wallet_id IN ${TW} OR user_id IN ${TU})`;
const TP = `(SELECT id FROM payments WHERE user_id IN ${TU} OR institution_id IN ${TI} OR recorded_by IN ${TU})`;

const sql = `
SELECT
  (SELECT count(*) FROM user WHERE id IN ${TU}) AS test_users,
  (SELECT count(*) FROM institutions WHERE id IN ${TI}) AS test_institutions,
  (SELECT count(*) FROM wallets WHERE id IN ${TW}) AS test_wallets,
  (SELECT count(*) FROM payments WHERE id IN ${TP}) AS test_payments;
DELETE FROM credit_requests WHERE wallet_id IN ${TW} OR parent_wallet_id IN ${TW} OR requested_by IN ${TU} OR payment_id IN ${TP} OR allotment_id IN ${TA};
DELETE FROM allotment_edits WHERE allotment_id IN ${TA};
DELETE FROM ledger_entries WHERE wallet_id IN ${TW} OR allotment_id IN ${TA} OR usage_id IN ${TUSAGE} OR created_by IN ${TU};
DELETE FROM credit_holds WHERE wallet_id IN ${TW};
DELETE FROM llm_usage WHERE id IN ${TUSAGE};
DELETE FROM allotments WHERE id IN ${TA};
DELETE FROM payments WHERE id IN ${TP};
DELETE FROM wallets WHERE id IN ${TW};
DELETE FROM enrolments WHERE user_id IN ${TU} OR institution_id IN ${TI} OR class_group_id IN ${TC};
UPDATE class_groups SET class_teacher_id = NULL WHERE class_teacher_id IN ${TU};
DELETE FROM class_groups WHERE id IN ${TC};
DELETE FROM institution_pocs WHERE user_id IN ${TU} OR institution_id IN ${TI};
DELETE FROM institutions WHERE id IN ${TI};
DELETE FROM session_events WHERE session_id IN (SELECT id FROM study_sessions WHERE user_id IN ${TU});
DELETE FROM study_sessions WHERE user_id IN ${TU};
DELETE FROM mastery WHERE user_id IN ${TU};
DELETE FROM card_reviews WHERE user_id IN ${TU};
DELETE FROM learner_artefacts WHERE user_id IN ${TU};
DELETE FROM learner_interests WHERE user_id IN ${TU};
DELETE FROM safety_events WHERE user_id IN ${TU};
DELETE FROM parent_contacts WHERE student_id IN ${TU};
DELETE FROM consents WHERE user_id IN ${TU};
DELETE FROM two_factor WHERE user_id IN ${TU};
DELETE FROM session WHERE user_id IN ${TU};
DELETE FROM account WHERE user_id IN ${TU};
DELETE FROM verification WHERE identifier LIKE '%@example.com%';
DELETE FROM audit_log WHERE actor_id IN ${TU};
DELETE FROM user WHERE id IN ${TU};
UPDATE wallets SET
  balance_micro = (SELECT coalesce(sum(amount_micro), 0) FROM ledger_entries l WHERE l.wallet_id = wallets.id),
  held_micro = (SELECT coalesce(sum(amount_micro), 0) FROM credit_holds h WHERE h.wallet_id = wallets.id AND h.status = 'held')
  WHERE owner_type = 'platform';
`;

const dir = mkdtempSync(path.join(os.tmpdir(), 'aicoach-cleanup-'));
const file = path.join(dir, 'cleanup.sql');
writeFileSync(file, sql);
const require = createRequire(import.meta.url);
const wranglerBin = path.join(
  path.dirname(require.resolve('wrangler/package.json')),
  'bin',
  'wrangler.js',
);
try {
  const out = execFileSync(
    process.execPath,
    [wranglerBin, 'd1', 'execute', 'DB', '--local', `--file=${file}`, '--json'],
    { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' },
  );
  const counts = JSON.parse(out)[0]?.results?.[0];
  console.log('Removed local test data:', counts ?? '(see wrangler output)');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
