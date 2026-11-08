import {
  assignByEmailSchema,
  createBoardSchema,
  createInstitutionSchema,
  createLevelSchema,
  createOfferingSchema,
  createSubjectSchema,
  updateInstitutionSchema,
  updateUserRoleSchema,
} from '@aicoach/core';
import {
  boards,
  institutionPocs,
  institutions,
  levels,
  subjectOfferings,
  subjects,
  user,
} from '@aicoach/db';
import { and, asc, desc, eq, like, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { audit } from '../lib/audit';
import { badRequest, conflict, isUniqueViolation, notFound, parseBody } from '../lib/http';
import { requireAuth, requireRole } from '../middleware/session';
import { listOfferings } from './catalog';

export const adminRoutes = new Hono<AppBindings>();
adminRoutes.use('*', requireAuth, requireRole('admin'));

async function insertOrConflict<T>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`${what} already exists`);
    throw err;
  }
}

// ---------------- Taxonomy ----------------

adminRoutes.get('/boards', async (c) =>
  c.json(await c.var.db.select().from(boards).orderBy(asc(boards.code))),
);

adminRoutes.post('/boards', async (c) => {
  const body = await parseBody(c, createBoardSchema);
  const row = await insertOrConflict(
    () =>
      c.var.db
        .insert(boards)
        .values({ code: body.code.toUpperCase(), name: body.name })
        .returning()
        .get(),
    'Board',
  );
  await audit(c.var.db, c.var.user.id, 'create', 'board', row.id, body);
  return c.json(row, 201);
});

adminRoutes.get('/levels', async (c) => {
  const boardId = c.req.query('boardId');
  const q = c.var.db.select().from(levels);
  const rows = boardId
    ? await q.where(eq(levels.boardId, boardId)).orderBy(asc(levels.sortOrder))
    : await q.orderBy(asc(levels.sortOrder));
  return c.json(rows);
});

adminRoutes.post('/levels', async (c) => {
  const body = await parseBody(c, createLevelSchema);
  const board = await c.var.db.select().from(boards).where(eq(boards.id, body.boardId)).get();
  if (!board) throw notFound('Board');
  const row = await insertOrConflict(
    () =>
      c.var.db
        .insert(levels)
        .values({ ...body, code: body.code.toUpperCase() })
        .returning()
        .get(),
    'Level',
  );
  await audit(c.var.db, c.var.user.id, 'create', 'level', row.id, body);
  return c.json(row, 201);
});

adminRoutes.get('/subjects', async (c) =>
  c.json(await c.var.db.select().from(subjects).orderBy(asc(subjects.name))),
);

adminRoutes.post('/subjects', async (c) => {
  const body = await parseBody(c, createSubjectSchema);
  const row = await insertOrConflict(
    () =>
      c.var.db
        .insert(subjects)
        .values({ ...body, code: body.code.toUpperCase() })
        .returning()
        .get(),
    'Subject',
  );
  await audit(c.var.db, c.var.user.id, 'create', 'subject', row.id, body);
  return c.json(row, 201);
});

adminRoutes.get('/offerings', async (c) => c.json(await listOfferings(c.var.db)));

adminRoutes.post('/offerings', async (c) => {
  const body = await parseBody(c, createOfferingSchema);
  const level = await c.var.db.select().from(levels).where(eq(levels.id, body.levelId)).get();
  if (!level) throw notFound('Level');
  if (level.boardId !== body.boardId) throw badRequest('Level does not belong to this board');
  const subject = await c.var.db
    .select()
    .from(subjects)
    .where(eq(subjects.id, body.subjectId))
    .get();
  if (!subject) throw notFound('Subject');
  const row = await insertOrConflict(
    () => c.var.db.insert(subjectOfferings).values(body).returning().get(),
    'Offering',
  );
  await audit(c.var.db, c.var.user.id, 'create', 'offering', row.id, body);
  return c.json(row, 201);
});

// ---------------- Institutions ----------------

adminRoutes.get('/institutions', async (c) => {
  const rows = await c.var.db
    .select({
      id: institutions.id,
      name: institutions.name,
      type: institutions.type,
      city: institutions.city,
      status: institutions.status,
      createdAt: institutions.createdAt,
      pocCount: sql<number>`(select count(*) from ${institutionPocs} where ${institutionPocs.institutionId} = ${institutions.id})`,
    })
    .from(institutions)
    .orderBy(asc(institutions.name));
  return c.json(rows);
});

adminRoutes.post('/institutions', async (c) => {
  const body = await parseBody(c, createInstitutionSchema);
  const row = await c.var.db.insert(institutions).values(body).returning().get();
  await audit(c.var.db, c.var.user.id, 'create', 'institution', row.id, body);
  return c.json(row, 201);
});

adminRoutes.patch('/institutions/:id', async (c) => {
  const body = await parseBody(c, updateInstitutionSchema);
  const row = await c.var.db
    .update(institutions)
    .set(body)
    .where(eq(institutions.id, c.req.param('id')))
    .returning()
    .get();
  if (!row) throw notFound('Institution');
  await audit(c.var.db, c.var.user.id, 'update', 'institution', row.id, body);
  return c.json(row);
});

adminRoutes.get('/institutions/:id/pocs', async (c) => {
  const rows = await c.var.db
    .select({ id: user.id, name: user.name, email: user.email, role: user.role })
    .from(institutionPocs)
    .innerJoin(user, eq(user.id, institutionPocs.userId))
    .where(eq(institutionPocs.institutionId, c.req.param('id')));
  return c.json(rows);
});

/**
 * Make an existing user a POC of an institution. Students cannot be POCs.
 * A teacher keeps the teacher role (and gains the POC area); any other user becomes institution_poc.
 */
adminRoutes.post('/institutions/:id/pocs', async (c) => {
  const { email } = await parseBody(c, assignByEmailSchema);
  const institutionId = c.req.param('id');
  const inst = await c.var.db
    .select()
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .get();
  if (!inst) throw notFound('Institution');
  const target = await c.var.db.select().from(user).where(eq(user.email, email)).get();
  if (!target) throw notFound('User with this email (ask them to sign up first)');
  if (target.role === 'student') throw badRequest('A student account cannot be an institution POC');
  if (target.role === 'admin') throw badRequest('Admins already manage every institution');
  await c.var.db
    .insert(institutionPocs)
    .values({ institutionId, userId: target.id })
    .onConflictDoNothing();
  if (target.role !== 'teacher' && target.role !== 'institution_poc') {
    await c.var.db.update(user).set({ role: 'institution_poc' }).where(eq(user.id, target.id));
  }
  await audit(c.var.db, c.var.user.id, 'assign_poc', 'institution', institutionId, {
    userId: target.id,
  });
  return c.json({ ok: true }, 201);
});

adminRoutes.delete('/institutions/:id/pocs/:userId', async (c) => {
  const { id: institutionId, userId } = c.req.param();
  await c.var.db
    .delete(institutionPocs)
    .where(
      and(eq(institutionPocs.institutionId, institutionId), eq(institutionPocs.userId, userId)),
    );
  await audit(c.var.db, c.var.user.id, 'remove_poc', 'institution', institutionId, { userId });
  return c.json({ ok: true });
});

// ---------------- Users ----------------

adminRoutes.get('/users', async (c) => {
  const q = c.req.query('q')?.trim();
  const role = c.req.query('role');
  const conds = [];
  if (q) conds.push(or(like(user.email, `%${q}%`), like(user.name, `%${q}%`)));
  if (role) conds.push(eq(user.role, role as 'student'));
  const rows = await c.var.db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(user.createdAt))
    .limit(100);
  return c.json(rows);
});

adminRoutes.patch('/users/:id/role', async (c) => {
  const { role } = await parseBody(c, updateUserRoleSchema);
  const id = c.req.param('id');
  if (id === c.var.user.id) throw badRequest('You cannot change your own role');
  const row = await c.var.db
    .update(user)
    .set({ role })
    .where(eq(user.id, id))
    .returning({ id: user.id, role: user.role })
    .get();
  if (!row) throw notFound('User');
  await audit(c.var.db, c.var.user.id, 'change_role', 'user', id, { role });
  return c.json(row);
});
