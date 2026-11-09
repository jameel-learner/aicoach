import { classGroups, creditRequests, enrolments, wallets, type Db } from '@aicoach/db';
import { and, eq, isNull } from 'drizzle-orm';
import { returnToParent } from './credits/ledger';
import type { SessionUser } from './env';
import { badRequest, notFound } from './lib/http';

/**
 * Removing an enrolment (decision 9.4-2). The row is kept with status 'removed' (history, and
 * re-joining reactivates it). For a student in a class, the unused balance of their class wallet
 * returns to the class wallet and their pending requests from it are cancelled; their own (direct)
 * credits are untouched. A class teacher's enrolment is ended by changing the class teacher instead.
 */
export async function removeEnrolment(
  db: Db,
  actor: SessionUser,
  userId: string,
  enrolmentId: string,
): Promise<{ returnedMicro: number }> {
  const e = await db
    .select()
    .from(enrolments)
    .where(and(eq(enrolments.id, enrolmentId), eq(enrolments.userId, userId)))
    .get();
  if (!e) throw notFound('Enrolment');
  if (e.status === 'removed') return { returnedMicro: 0 };

  if (e.classGroupId && e.roleIn === 'teacher') {
    const cls = await db
      .select({ teacher: classGroups.classTeacherId })
      .from(classGroups)
      .where(eq(classGroups.id, e.classGroupId))
      .get();
    if (cls?.teacher === userId)
      throw badRequest(
        "This teacher is the class teacher. Use Change teacher on the institution's page instead.",
      );
  }

  const stmts: unknown[] = [
    db.update(enrolments).set({ status: 'removed' }).where(eq(enrolments.id, e.id)),
  ];
  const classW =
    e.classGroupId && e.roleIn === 'student'
      ? await db
          .select()
          .from(wallets)
          .where(
            and(
              eq(wallets.ownerType, 'user'),
              eq(wallets.userId, userId),
              eq(wallets.classGroupId, e.classGroupId),
            ),
          )
          .get()
      : undefined;
  if (!classW) {
    await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);
    return { returnedMicro: 0 };
  }
  stmts.push(
    db
      .update(creditRequests)
      .set({
        status: 'cancelled',
        decidedBy: actor.id,
        decidedAt: new Date(),
        decisionNote: 'Removed from the class',
      })
      .where(and(eq(creditRequests.walletId, classW.id), eq(creditRequests.status, 'pending'))),
  );
  const returnedMicro = await returnToParent(
    db,
    actor,
    classW,
    'Returned to the class: student removed from the class',
    stmts,
  );
  return { returnedMicro };
}

/**
 * Inserts an enrolment, or reactivates the same one if it was removed before.
 * Returns null when it is already active (the caller answers "already enrolled").
 */
export async function enrolOrReactivate(
  db: Db,
  values: typeof enrolments.$inferInsert,
): Promise<typeof enrolments.$inferSelect | null> {
  const existing = await db
    .select()
    .from(enrolments)
    .where(
      and(
        eq(enrolments.userId, values.userId),
        eq(enrolments.offeringId, values.offeringId),
        values.classGroupId
          ? eq(enrolments.classGroupId, values.classGroupId)
          : isNull(enrolments.classGroupId),
      ),
    )
    .get();
  if (existing?.status === 'active') return null;
  if (existing)
    return db
      .update(enrolments)
      .set({ status: 'active', roleIn: values.roleIn })
      .where(eq(enrolments.id, existing.id))
      .returning()
      .get();
  return db.insert(enrolments).values(values).returning().get();
}
