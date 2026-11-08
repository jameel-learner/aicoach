import {
  classGroups,
  enrolments,
  institutionPocs,
  institutions,
  user,
  wallets,
  type Db,
} from '@aicoach/db';
import { and, eq } from 'drizzle-orm';
import type { SessionUser } from '../env';
import { notFound } from '../lib/http';

/**
 * Wallet tree (architecture §6.6):
 *   /p                              platform (Admin)
 *   /p/i:<inst>                     institution (managed by its POCs)
 *   /p/i:<inst>/c:<class>           class (managed by the class teacher)
 *   /p/i:<inst>/c:<class>/u:<user>  student in that class
 *   /p/u:<user>                     direct (self-funded) teacher or student, decision 6.3
 * Paths are deterministic, so wallets are created lazily and idempotently.
 */
export type Wallet = typeof wallets.$inferSelect;

export const PLATFORM_PATH = '/p';
export const institutionPath = (institutionId: string) => `${PLATFORM_PATH}/i:${institutionId}`;
export const classPath = (institutionId: string, classGroupId: string) =>
  `${institutionPath(institutionId)}/c:${classGroupId}`;
export const studentInClassPath = (institutionId: string, classGroupId: string, userId: string) =>
  `${classPath(institutionId, classGroupId)}/u:${userId}`;
export const directUserPath = (userId: string) => `${PLATFORM_PATH}/u:${userId}`;

async function byPath(db: Db, path: string) {
  return db.select().from(wallets).where(eq(wallets.path, path)).get();
}

async function ensure(
  db: Db,
  values: Omit<typeof wallets.$inferInsert, 'id' | 'balanceMicro' | 'heldMicro'>,
): Promise<Wallet> {
  const existing = await byPath(db, values.path);
  if (existing) return existing;
  await db.insert(wallets).values(values).onConflictDoNothing();
  return (await byPath(db, values.path))!;
}

export async function platformWallet(db: Db) {
  return ensure(db, { ownerType: 'platform', path: PLATFORM_PATH, parentWalletId: null });
}

export async function institutionWallet(db: Db, institutionId: string) {
  const parent = await platformWallet(db);
  return ensure(db, {
    ownerType: 'institution',
    institutionId,
    path: institutionPath(institutionId),
    parentWalletId: parent.id,
  });
}

export async function classWallet(db: Db, classGroupId: string) {
  const cls = await db.select().from(classGroups).where(eq(classGroups.id, classGroupId)).get();
  if (!cls) throw notFound('Class');
  const parent = await institutionWallet(db, cls.institutionId);
  return ensure(db, {
    ownerType: 'class',
    institutionId: cls.institutionId,
    classGroupId,
    path: classPath(cls.institutionId, classGroupId),
    parentWalletId: parent.id,
  });
}

export async function studentClassWallet(db: Db, userId: string, classGroupId: string) {
  const parent = await classWallet(db, classGroupId);
  return ensure(db, {
    ownerType: 'user',
    userId,
    institutionId: parent.institutionId,
    classGroupId,
    path: studentInClassPath(parent.institutionId!, classGroupId, userId),
    parentWalletId: parent.id,
  });
}

export async function directUserWallet(db: Db, userId: string) {
  const parent = await platformWallet(db);
  return ensure(db, {
    ownerType: 'user',
    userId,
    path: directUserPath(userId),
    parentWalletId: parent.id,
  });
}

export async function getWallet(db: Db, id: string): Promise<Wallet> {
  const w = await db.select().from(wallets).where(eq(wallets.id, id)).get();
  if (!w) throw notFound('Wallet');
  return w;
}

export const available = (w: Pick<Wallet, 'balanceMicro' | 'heldMicro'>) =>
  w.balanceMicro - w.heldMicro;

// ---------------------------------------------------------------------------------------------
// Roles on a wallet
// ---------------------------------------------------------------------------------------------

/**
 * The person(s) a wallet belongs to: they receive allotments into it and acknowledge them.
 * Admin is NOT a receiver of other people's wallets (acknowledgement must come from the receiver).
 */
export async function isReceiver(db: Db, u: SessionUser, w: Wallet): Promise<boolean> {
  switch (w.ownerType) {
    case 'platform':
      return u.role === 'admin';
    case 'institution': {
      const row = await db
        .select({ x: institutionPocs.userId })
        .from(institutionPocs)
        .where(
          and(
            eq(institutionPocs.institutionId, w.institutionId!),
            eq(institutionPocs.userId, u.id),
          ),
        )
        .get();
      return !!row;
    }
    case 'class': {
      const cls = await db
        .select({ t: classGroups.classTeacherId })
        .from(classGroups)
        .where(eq(classGroups.id, w.classGroupId!))
        .get();
      return cls?.t === u.id;
    }
    case 'user':
      return w.userId === u.id;
  }
}

/** Can act for this wallet (give from it, see its children). Admin can act for every wallet. */
export async function canManage(db: Db, u: SessionUser, w: Wallet): Promise<boolean> {
  if (u.role === 'admin') return true;
  return isReceiver(db, u, w);
}

/** Visibility rule 6.5: own wallet + immediate downline; Admin sees everything. */
export async function canView(db: Db, u: SessionUser, w: Wallet): Promise<boolean> {
  if (await canManage(db, u, w)) return true;
  if (!w.parentWalletId) return false;
  const parent = await getWallet(db, w.parentWalletId);
  return canManage(db, u, parent);
}

/** People who manage a wallet: used for notifications (e.g. "credits received", "credits requested"). */
export async function walletManagers(
  db: Db,
  w: Wallet,
): Promise<{ email: string; name: string }[]> {
  switch (w.ownerType) {
    case 'platform':
      return db
        .select({ email: user.email, name: user.name })
        .from(user)
        .where(eq(user.role, 'admin'));
    case 'institution':
      return db
        .select({ email: user.email, name: user.name })
        .from(institutionPocs)
        .innerJoin(user, eq(user.id, institutionPocs.userId))
        .where(eq(institutionPocs.institutionId, w.institutionId!));
    case 'class':
      return db
        .select({ email: user.email, name: user.name })
        .from(classGroups)
        .innerJoin(user, eq(user.id, classGroups.classTeacherId))
        .where(eq(classGroups.id, w.classGroupId!));
    case 'user':
      return db
        .select({ email: user.email, name: user.name })
        .from(user)
        .where(eq(user.id, w.userId!));
  }
}

/** Human label for a wallet. */
export async function walletLabel(db: Db, w: Wallet): Promise<string> {
  switch (w.ownerType) {
    case 'platform':
      return 'Platform (Admin)';
    case 'institution': {
      const i = await db
        .select({ n: institutions.name })
        .from(institutions)
        .where(eq(institutions.id, w.institutionId!))
        .get();
      return i?.n ?? 'Institution';
    }
    case 'class': {
      const c = await db
        .select({ n: classGroups.name })
        .from(classGroups)
        .where(eq(classGroups.id, w.classGroupId!))
        .get();
      return c?.n ?? 'Class';
    }
    case 'user': {
      const u = await db
        .select({ n: user.name, e: user.email })
        .from(user)
        .where(eq(user.id, w.userId!))
        .get();
      return u ? `${u.n} (${u.e})${w.classGroupId ? '' : ' · direct'}` : 'User';
    }
  }
}

/**
 * Children of a wallet, creating wallets lazily so every class / enrolled student appears:
 * platform → institutions + direct user wallets; institution → classes; class → enrolled students.
 */
export async function listChildren(db: Db, w: Wallet): Promise<Wallet[]> {
  if (w.ownerType === 'platform') {
    const insts = await db.select({ id: institutions.id }).from(institutions);
    for (const i of insts) await institutionWallet(db, i.id);
  } else if (w.ownerType === 'institution') {
    const classes = await db
      .select({ id: classGroups.id })
      .from(classGroups)
      .where(eq(classGroups.institutionId, w.institutionId!));
    for (const c of classes) await classWallet(db, c.id);
  } else if (w.ownerType === 'class') {
    const students = await db
      .select({ userId: enrolments.userId })
      .from(enrolments)
      .where(
        and(
          eq(enrolments.classGroupId, w.classGroupId!),
          eq(enrolments.roleIn, 'student'),
          eq(enrolments.status, 'active'),
        ),
      );
    for (const s of students) await studentClassWallet(db, s.userId, w.classGroupId!);
  } else {
    return [];
  }
  return db.select().from(wallets).where(eq(wallets.parentWalletId, w.id));
}
