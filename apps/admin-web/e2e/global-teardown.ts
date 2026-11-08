import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Removes the test accounts, colleges and credits this run created from the LOCAL database. */
export default function globalTeardown() {
  execFileSync(process.execPath, ['scripts/cleanup-test-data.mjs', '--local'], {
    cwd: path.resolve(import.meta.dirname, '../../worker'),
    stdio: 'inherit',
  });
}
