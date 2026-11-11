import { createDb } from '@aicoach/db';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { runCompile, type CompileParams } from './compile';

/**
 * Durable CompileStrategy run (LOCAL, like IngestBook). One retry per step: a step already retries
 * a bad JSON reply itself, so more Workflow retries would mostly repeat paid calls.
 */
export class CompileStrategyWorkflow extends WorkflowEntrypoint<Env, CompileParams> {
  override async run(event: WorkflowEvent<CompileParams>, step: WorkflowStep) {
    const db = createDb(this.env.DB);
    await runCompile(this.env, db, event.payload, {
      do: <T>(name: string, fn: () => Promise<T>) =>
        step.do(
          name,
          { retries: { limit: 1, delay: '15 seconds', backoff: 'constant' } },
          fn as never,
        ) as Promise<T>,
    });
  }
}
