// wrangler requires the assets directory to exist even when the web app hasn't been built yet.
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
const dir = new URL('../../admin-web/dist/', import.meta.url);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    new URL('index.html', dir),
    '<!doctype html><title>AI Coach</title><p>Web app not built yet. Run <code>pnpm dev:web</code> (port 5173) or <code>pnpm --filter @aicoach/admin-web build</code>.</p>',
  );
}
