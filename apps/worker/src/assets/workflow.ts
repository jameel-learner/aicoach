import { createDb } from '@aicoach/db';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { runGenerate, type GenerateParams } from './generate';

/** Durable learning-material generation (LOCAL). One retry per note: retries repeat paid calls. */
export class GenerateAssetsWorkflow extends WorkflowEntrypoint<Env, GenerateParams> {
  override async run(event: WorkflowEvent<GenerateParams>, step: WorkflowStep) {
    const db = createDb(this.env.DB);
    await runGenerate(this.env, db, event.payload, {
      do: <T>(name: string, fn: () => Promise<T>) =>
        step.do(
          name,
          { retries: { limit: 1, delay: '15 seconds', backoff: 'constant' } },
          fn as never,
        ) as Promise<T>,
    });
  }
}
