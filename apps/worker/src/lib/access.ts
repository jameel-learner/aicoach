import { classGroups, enrolments, institutionPocs, type Db } from '@aicoach/db';
import { and, eq } from 'drizzle-orm';
import type { SessionUser } from '../env';
import { forbidden, notFound } from './http';

/**
 * Tenant & hierarchy authorisation (architecture §2.2, §6.6 visibility rules).
 * Always enforced server-side.
 */

export async function isPocOf(db: Db, userId: string, institutionId: string): Promise<boolean> {
  const row = await db
    .select({ u: institutionPocs.userId })
    .from(institutionPocs)
    .where(
      and(eq(institutionPocs.userId, userId), eq(institutionPocs.institutionId, institutionId)),
    )
    .get();
  return !!row;
}

/** Admin, or POC of this institution. */
export async function assertInstitutionManager(db: Db, user: SessionUser, institutionId: string) {
  if (user.role === 'admin') return;
  if (await isPocOf(db, user.id, institutionId)) return;
  throw forbidden();
}

/**
 * Who may see a class and its students: Admin, a POC of the class's institution,
 * the class teacher, or a teacher enrolled in the class.
 */
export async function assertClassViewer(db: Db, user: SessionUser, classGroupId: string) {
  const cls = await db.select().from(classGroups).where(eq(classGroups.id, classGroupId)).get();
  if (!cls) throw notFound('Class');
  if (user.role === 'admin') return cls;
  if (cls.classTeacherId === user.id) return cls;
  if (await isPocOf(db, user.id, cls.institutionId)) return cls;
  if (user.role === 'teacher') {
    const enr = await db
      .select({ id: enrolments.id })
      .from(enrolments)
      .where(
        and(
          eq(enrolments.userId, user.id),
          eq(enrolments.classGroupId, classGroupId),
          eq(enrolments.roleIn, 'teacher'),
          eq(enrolments.status, 'active'),
        ),
      )
      .get();
    if (enr) return cls;
  }
  throw forbidden();
}
