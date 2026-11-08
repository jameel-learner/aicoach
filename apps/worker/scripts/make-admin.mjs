// Promote an existing (signed-up) user to Admin.
// Usage: pnpm --filter @aicoach/worker db:make-admin:local -- someone@example.com
//        node scripts/make-admin.mjs --env staging someone@example.com   (remote)
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '--');
const local = args.includes('--local');
const envIdx = args.indexOf('--env');
const envName = envIdx >= 0 ? args[envIdx + 1] : undefined;
const email = args.find((a) => a.includes('@'));

if (!email || !/^[^\s'"@]+@[^\s'"@]+\.[^\s'"@]+$/.test(email)) {
  console.error('Usage: make-admin.mjs [--local | --env <name>] <email>');
  process.exit(1);
}

const sql = `UPDATE user SET role = 'admin' WHERE email = '${email.toLowerCase()}'; SELECT email, role FROM user WHERE email = '${email.toLowerCase()}';`;
const wranglerArgs = ['d1', 'execute', 'DB', '--command', sql];
if (local) wranglerArgs.push('--local');
else wranglerArgs.push('--remote');
if (envName) wranglerArgs.push('--env', envName);

// Run wrangler's JS entry with Node directly: no shell, so the SQL quoting is safe on Windows too.
const require = createRequire(import.meta.url);
const wranglerBin = path.join(
  path.dirname(require.resolve('wrangler/package.json')),
  'bin',
  'wrangler.js',
);
execFileSync(process.execPath, [wranglerBin, ...wranglerArgs], {
  stdio: 'inherit',
  cwd: path.join(import.meta.dirname, '..'),
});
