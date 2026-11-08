// Start the Expo dev server against a given backend environment.
//   node scripts/start.mjs local | staging | production
// EXPO_PUBLIC_* values are inlined into the bundle, so switching environments clears Metro's cache.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const env = process.argv[2] ?? 'local';
if (!['local', 'staging', 'production'].includes(env)) {
  console.error(`Unknown environment "${env}". Use local, staging or production.`);
  process.exit(1);
}

const appDir = path.join(import.meta.dirname, '..');
const marker = path.join(appDir, '.expo', 'last-app-env');
const last = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
const clear = last !== env;
mkdirSync(path.dirname(marker), { recursive: true });
writeFileSync(marker, env);

const require = createRequire(import.meta.url);
const expoCli = path.join(path.dirname(require.resolve('expo/package.json')), 'bin', 'cli');
const args = [expoCli, 'start', ...(clear ? ['--clear'] : []), ...process.argv.slice(3)];

console.log(
  `\n  AI Coach mobile → ${env.toUpperCase()} backend${clear ? ' (cache cleared: environment changed)' : ''}\n`,
);
const child = spawn(process.execPath, args, {
  cwd: appDir,
  stdio: 'inherit',
  env: { ...process.env, EXPO_PUBLIC_APP_ENV: env },
});
child.on('exit', (code) => process.exit(code ?? 0));
