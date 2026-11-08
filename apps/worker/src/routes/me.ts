import {
  directEnrolSchema,
  joinClassSchema,
  parentContactSchema,
  type EnrolmentView,
  type MeResponse,
} from '@aicoach/core';
import {
  boards,
  classGroups,
  consents,
  enrolments,
  institutionPocs,
  institutions,
  levels,
  parentContacts,
  subjectOfferings,
  subjects,
  type Db,
} from '@aicoach/db';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppBindings, Env, SessionUser } from '../env';
import { audit } from '../lib/audit';
import { parentConsentEmail } from '../lib/emails';
import {
  badRequest,
  conflict,
  forbidden,
  isUniqueViolation,
  notFound,
  parseBody,
} from '../lib/http';
import type { Notifier } from '../lib/notifier';
import { randomToken, sha256Hex } from '../lib/tokens';
import { requireAuth, requireRole } from '../middleware/session';

export const CONSENT_VERSION = '2026-11-v1';

export async function listMyEnrolments(db: Db, userId: string): Promise<EnrolmentView[]> {
  const rows = await db
    .select({
      id: enrolments.id,
      roleIn: enrolments.roleIn,
      offering: {
        id: subjectOfferings.id,
        board: boards.code,
        level: levels.name,
        subject: subjects.name,
      },
      institutionId: institutions.id,
      institutionName: institutions.name,
      classGroupId: classGroups.id,
      classGroupName: classGroups.name,
    })
    .from(enrolments)
    .innerJoin(subjectOfferings, eq(subjectOfferings.id, enrolments.offeringId))
    .innerJoin(boards, eq(boards.id, subjectOfferings.boardId))
    .innerJoin(levels, eq(levels.id, subjectOfferings.levelId))
    .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
    .leftJoin(institutions, eq(institutions.id, enrolments.institutionId))
    .leftJoin(classGroups, eq(classGroups.id, enrolments.classGroupId))
    .where(and(eq(enrolments.userId, userId), eq(enrolments.status, 'active')))
    .orderBy(asc(enrolments.createdAt));
  return rows.map((r) => ({
    id: r.id,
    roleIn: r.roleIn,
    offering: r.offering,
    institution: r.institutionId ? { id: r.institutionId, name: r.institutionName! } : null,
    classGroup: r.classGroupId ? { id: r.classGroupId, name: r.classGroupName! } : null,
  }));
}

async function sendParentConsentRequest(
  env: Env,
  db: Db,
  notifier: Notifier,
  student: SessionUser,
  contact: { id: string; name: string; email: string },
) {
  const token = randomToken();
  await db
    .update(parentContacts)
    .set({
      consentTokenHash: await sha256Hex(token),
      consentRequestedAt: new Date(),
      consentStatus: 'pending',
    })
    .where(eq(parentContacts.id, contact.id));
  const link = `${env.APP_URL}/api/parent-consent?token=${encodeURIComponent(token)}`;
  await notifier.send(
    parentConsentEmail({
      to: contact.email,
      parentName: contact.name,
      studentName: student.name,
      link,
    }),
  );
}

export const meRoutes = new Hono<AppBindings>();
meRoutes.use('*', requireAuth);

meRoutes.get('/', async (c) => {
  const { db, user } = c.var;
  const [enrols, pocRows, parent] = await Promise.all([
    listMyEnrolments(db, user.id),
    db
      .select({ id: institutions.id, name: institutions.name })
      .from(institutionPocs)
      .innerJoin(institutions, eq(institutions.id, institutionPocs.institutionId))
      .where(eq(institutionPocs.userId, user.id))
      .orderBy(asc(institutions.name)),
    db.select().from(parentContacts).where(eq(parentContacts.studentId, user.id)).get(),
  ]);
  const learnerRole = user.role === 'student' || user.role === 'teacher';
  const body: MeResponse = {
    user,
    enrolments: enrols,
    pocInstitutions: pocRows,
    parentContact: parent
      ? {
          name: parent.name,
          email: parent.email,
          relationship: parent.relationship,
          consentStatus: parent.consentStatus,
        }
      : null,
    onboarding: {
      needsParentContact: user.role === 'student' && !parent,
      needsEnrolment: learnerRole && enrols.length === 0,
    },
  };
  return c.json(body);
});

// ---------------- Enrolment ----------------

meRoutes.post('/enrolments/join', requireRole('student', 'teacher'), async (c) => {
  const { joinCode } = await parseBody(c, joinClassSchema);
  const cls = await c.var.db
    .select()
    .from(classGroups)
    .where(eq(classGroups.joinCode, joinCode))
    .get();
  if (!cls) throw notFound('Class with this join code');
  const inst = await c.var.db
    .select()
    .from(institutions)
    .where(eq(institutions.id, cls.institutionId))
    .get();
  if (!inst || inst.status !== 'active')
    throw forbidden('This institution is not accepting enrolments');
  try {
    const row = await c.var.db
      .insert(enrolments)
      .values({
        userId: c.var.user.id,
        roleIn: c.var.user.role === 'teacher' ? 'teacher' : 'student',
        offeringId: cls.offeringId,
        institutionId: cls.institutionId,
        classGroupId: cls.id,
      })
      .returning()
      .get();
    return c.json(row, 201);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('You are already enrolled in this class');
    throw err;
  }
});

/** Direct (non-institution) enrolment in a subject offering, decision 6.3. */
meRoutes.post('/enrolments/direct', requireRole('student', 'teacher'), async (c) => {
  const { offeringId } = await parseBody(c, directEnrolSchema);
  const offering = await c.var.db
    .select()
    .from(subjectOfferings)
    .where(eq(subjectOfferings.id, offeringId))
    .get();
  if (!offering) throw notFound('Subject offering');
  try {
    const row = await c.var.db
      .insert(enrolments)
      .values({
        userId: c.var.user.id,
        roleIn: c.var.user.role === 'teacher' ? 'teacher' : 'student',
        offeringId,
      })
      .returning()
      .get();
    return c.json(row, 201);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('You are already enrolled in this subject');
    throw err;
  }
});

// ---------------- Parent contact & consent ----------------

/** Student sets (or replaces) their parent contact. Sends the parent a consent request email. */
meRoutes.put('/parent-contact', requireRole('student'), async (c) => {
  const body = await parseBody(c, parentContactSchema);
  const { db, user } = c.var;
  if (body.email === user.email.toLowerCase())
    throw badRequest("Parent email can't be your own email");

  const existing = await db
    .select()
    .from(parentContacts)
    .where(eq(parentContacts.studentId, user.id))
    .get();
  const values = { name: body.name, email: body.email, relationship: body.relationship };
  const contact = existing
    ? await db
        .update(parentContacts)
        .set({ ...values, consentStatus: 'pending', consentVerifiedAt: null })
        .where(eq(parentContacts.id, existing.id))
        .returning()
        .get()
    : await db
        .insert(parentContacts)
        .values({ ...values, studentId: user.id })
        .returning()
        .get();

  await db.insert(consents).values({
    userId: user.id,
    type: 'safety_parent_alerts',
    version: CONSENT_VERSION,
    grantedBy: 'self',
    grantedAt: new Date(),
  });
  await sendParentConsentRequest(c.env, db, c.var.notifier, user, contact!);
  await audit(db, user.id, existing ? 'update' : 'create', 'parent_contact', contact!.id, {
    email: body.email,
  });
  return c.json({ ok: true, consentStatus: 'pending' });
});

meRoutes.post('/parent-contact/resend', requireRole('student'), async (c) => {
  const { db, user } = c.var;
  const contact = await db
    .select()
    .from(parentContacts)
    .where(eq(parentContacts.studentId, user.id))
    .get();
  if (!contact) throw notFound('Parent contact');
  if (contact.consentStatus === 'verified') throw badRequest('Your parent has already confirmed');
  const last = contact.consentRequestedAt?.getTime() ?? 0;
  if (Date.now() - last < 60_000) throw badRequest('Please wait a minute before sending again');
  await sendParentConsentRequest(c.env, db, c.var.notifier, user, contact);
  return c.json({ ok: true });
});
