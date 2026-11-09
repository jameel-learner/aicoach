import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

declare global {
  // Declaration merging into Cloudflare's global Env type requires a namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      CONTENT: R2Bucket;
      TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
