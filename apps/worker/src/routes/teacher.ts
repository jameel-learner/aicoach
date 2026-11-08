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
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { assertClassViewer } from '../lib/access';
import { requireAuth, requireRole } from '../middleware/session';

/** Teacher area: my classes → my students (immediate downline of the class). */
export const teacherRoutes = new Hono<AppBindings>();
teacherRoutes.use('*', requireAuth);

teacherRoutes.get('/classes', requireRole('teacher'), async (c) => {
  const me = c.var.user.id;
  const myTeacherEnrolment = sql`exists (select 1 from ${enrolments} e where e.class_group_id = ${classGroups.id} and e.user_id = ${me} and e.role_in = 'teacher' and e.status = 'active')`;
  const rows = await c.var.db
    .select({
      id: classGroups.id,
      name: classGroups.name,
      academicYear: classGroups.academicYear,
      joinCode: classGroups.joinCode,
      isClassTeacher: sql<number>`${classGroups.classTeacherId} = ${me}`,
      institution: { id: institutions.id, name: institutions.name },
      offering: {
        id: subjectOfferings.id,
        board: boards.code,
        level: levels.name,
        subject: subjects.name,
      },
      studentCount: sql<number>`(select count(*) from ${enrolments} where ${enrolments.classGroupId} = ${classGroups.id} and ${enrolments.roleIn} = 'student' and ${enrolments.status} = 'active')`,
    })
    .from(classGroups)
    .innerJoin(institutions, eq(institutions.id, classGroups.institutionId))
    .innerJoin(subjectOfferings, eq(subjectOfferings.id, classGroups.offeringId))
    .innerJoin(boards, eq(boards.id, subjectOfferings.boardId))
    .innerJoin(levels, eq(levels.id, subjectOfferings.levelId))
    .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
    .where(or(eq(classGroups.classTeacherId, me), myTeacherEnrolment))
    .orderBy(asc(institutions.name), asc(classGroups.name));
  return c.json(rows.map((r) => ({ ...r, isClassTeacher: !!r.isClassTeacher })));
});

/** Students in a class. Visible to the class's teachers, the institution POC and Admin. */
teacherRoutes.get('/classes/:classId/students', async (c) => {
  const classId = c.req.param('classId');
  await assertClassViewer(c.var.db, c.var.user, classId);
  const rows = await c.var.db
    .select({ id: user.id, name: user.name, email: user.email, enrolledAt: enrolments.createdAt })
    .from(enrolments)
    .innerJoin(user, eq(user.id, enrolments.userId))
    .where(
      and(
        eq(enrolments.classGroupId, classId),
        eq(enrolments.roleIn, 'student'),
        eq(enrolments.status, 'active'),
      ),
    )
    .orderBy(asc(user.name));
  return c.json(rows);
});
