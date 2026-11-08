import { auditLog, type Db } from '@aicoach/db';

/** Append an audit record for an administrative action. Never throws (audit must not break the request). */
export async function audit(
  db: Db,
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  data?: unknown,
): Promise<void> {
  try {
    await db.insert(auditLog).values({ actorId, action, entity, entityId, data: data ?? null });
  } catch (err) {
    console.error('audit write failed', err);
  }
}
