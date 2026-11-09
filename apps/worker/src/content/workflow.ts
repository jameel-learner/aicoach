import { createDb } from '@aicoach/db';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { runIngest, type IngestParams } from './ingest';

/**
 * Durable textbook ingestion (architecture §3.4). Each page batch / embedding batch is a separate
 * step, so an interrupted run resumes where it stopped and a failing call is retried on its own.
 */
export class IngestBookWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  override async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep) {
    const db = createDb(this.env.DB);
    await runIngest(this.env, db, event.payload, {
      // Workflow step results must be serialisable; our steps return numbers/void.
      do: <T>(name: string, fn: () => Promise<T>) =>
        step.do(
          name,
          { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } },
          fn as never,
        ) as Promise<T>,
    });
  }
}
