import type { OfferingView } from '@aicoach/core';
import { boards, levels, subjectOfferings, subjects, type Db } from '@aicoach/db';
import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { requireAuth } from '../middleware/session';

export async function listOfferings(db: Db): Promise<OfferingView[]> {
  const rows = await db
    .select({
      id: subjectOfferings.id,
      board: { id: boards.id, code: boards.code, name: boards.name },
      level: { id: levels.id, code: levels.code, name: levels.name },
      subject: { id: subjects.id, code: subjects.code, name: subjects.name },
    })
    .from(subjectOfferings)
    .innerJoin(boards, eq(boards.id, subjectOfferings.boardId))
    .innerJoin(levels, eq(levels.id, subjectOfferings.levelId))
    .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
    .orderBy(asc(boards.code), asc(levels.sortOrder), asc(subjects.name));
  return rows;
}

export const catalogRoutes = new Hono<AppBindings>();
catalogRoutes.use('*', requireAuth);
catalogRoutes.get('/offerings', async (c) => c.json(await listOfferings(c.var.db)));
