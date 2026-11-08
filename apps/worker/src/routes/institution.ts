import { assignClassTeacherSchema, createClassGroupSchema, generateJoinCode } from '@aicoach/core';
import {
  boards,
  classGroups,
  enrolments,
  institutions,
  levels,
  subjectOfferings,
  subjects,
  user,
} from '@aicoach/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { assertInstitutionManager } from '../lib/access';
import { audit } from '../lib/audit';
import { badRequest, isUniqueViolation, notFound, parseBody } from '../lib/http';
import { requireAuth } from '../middleware/session';

/**
 * Institution POC area: classes and their teachers (immediate downline of the institution).
 * Admin can use every endpoint too.
 */
export const institutionRoutes = new Hono<AppBindings>();
institutionRoutes.use('*', requireAuth);

institutionRoutes.get('/:institutionId', async (c) => {
  const institutionId = c.req.param('institutionId');
  await assertInstitutionManager(c.var.db, c.var.user, institutionId);
  const inst = await c.var.db
    .select()
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .get();
  if (!inst) throw notFound('Institution');
  return c.json(inst);
});

institutionRoutes.get('/:institutionId/classes', async (c) => {
  const institutionId = c.req.param('institutionId');
  await assertInstitutionManager(c.var.db, c.var.user, institutionId);
  const rows = await c.var.db
    .select({
      id: classGroups.id,
      name: classGroups.name,
      academicYear: classGroups.academicYear,
      joinCode: classGroups.joinCode,
      offering: {
        id: subjectOfferings.id,
        board: boards.code,
        level: levels.name,
        subject: subjects.name,
      },
      classTeacher: { id: user.id, name: user.name, email: user.email },
      studentCount: sql<number>`(select count(*) from ${enrolments} where ${enrolments.classGroupId} = ${classGroups.id} and ${enrolments.roleIn} = 'student' and ${enrolments.status} = 'active')`,
    })
    .from(classGroups)
    .innerJoin(subjectOfferings, eq(subjectOfferings.id, classGroups.offeringId))
    .innerJoin(boards, eq(boards.id, subjectOfferings.boardId))
    .innerJoin(levels, eq(levels.id, subjectOfferings.levelId))
    .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
    .leftJoin(user, eq(user.id, classGroups.classTeacherId))
    .where(eq(classGroups.institutionId, institutionId))
    .orderBy(asc(classGroups.name));
  // leftJoin yields {id:null,...} when no teacher; normalise to null
  return c.json(
    rows.map((r) => ({ ...r, classTeacher: r.classTeacher?.id ? r.classTeacher : null })),
  );
});

institutionRoutes.post('/:institutionId/classes', async (c) => {
  const institutionId = c.req.param('institutionId');
  await assertInstitutionManager(c.var.db, c.var.user, institutionId);
  const body = await parseBody(c, createClassGroupSchema);
  const offering = await c.var.db
    .select()
    .from(subjectOfferings)
    .where(eq(subjectOfferings.id, body.offeringId))
    .get();
  if (!offering) throw notFound('Subject offering');
  // Retry on the (very unlikely) join-code collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const row = await c.var.db
        .insert(classGroups)
        .values({ ...body, institutionId, joinCode: generateJoinCode() })
        .returning()
        .get();
      await audit(c.var.db, c.var.user.id, 'create', 'class_group', row.id, body);
      return c.json(row, 201);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error('Could not generate a unique join code');
});

/** Assign the class teacher by email. The teacher is also enrolled in the class as a teacher. */
institutionRoutes.put('/:institutionId/classes/:classId/teacher', async (c) => {
  const { institutionId, classId } = c.req.param();
  await assertInstitutionManager(c.var.db, c.var.user, institutionId);
  const { email } = await parseBody(c, assignClassTeacherSchema);
  const cls = await c.var.db
    .select()
    .from(classGroups)
    .where(and(eq(classGroups.id, classId), eq(classGroups.institutionId, institutionId)))
    .get();
  if (!cls) throw notFound('Class');
  const teacher = await c.var.db.select().from(user).where(eq(user.email, email)).get();
  if (!teacher) throw notFound('User with this email (ask them to sign up as a teacher first)');
  if (teacher.role !== 'teacher') throw badRequest('Only a teacher account can be a class teacher');

  await c.var.db.batch([
    c.var.db
      .update(classGroups)
      .set({ classTeacherId: teacher.id })
      .where(eq(classGroups.id, classId)),
    c.var.db
      .insert(enrolments)
      .values({
        userId: teacher.id,
        roleIn: 'teacher',
        offeringId: cls.offeringId,
        institutionId,
        classGroupId: classId,
      })
      .onConflictDoNothing(),
  ]);
  await audit(c.var.db, c.var.user.id, 'assign_class_teacher', 'class_group', classId, {
    teacherId: teacher.id,
  });
  return c.json({ ok: true });
});

/** Teachers of this institution (immediate downline view for the POC). */
institutionRoutes.get('/:institutionId/teachers', async (c) => {
  const institutionId = c.req.param('institutionId');
  await assertInstitutionManager(c.var.db, c.var.user, institutionId);
  const rows = await c.var.db
    .selectDistinct({ id: user.id, name: user.name, email: user.email })
    .from(enrolments)
    .innerJoin(user, eq(user.id, enrolments.userId))
    .where(
      and(
        eq(enrolments.institutionId, institutionId),
        eq(enrolments.roleIn, 'teacher'),
        eq(enrolments.status, 'active'),
      ),
    )
    .orderBy(asc(user.name));
  return c.json(rows);
});
