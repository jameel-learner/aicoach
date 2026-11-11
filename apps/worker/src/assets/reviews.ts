import { assetReviews, learningAssets, user, type Db } from '@aicoach/db';
import { and, desc, eq, sql } from 'drizzle-orm';

/**
 * Teacher (and Admin) rubric scores on generated assets (Phase 3 exit: teacher rubric ≥ 4/5 on a
 * sample). One review per reviewer per asset version; reviewing again updates it. Reviews never
 * approve anything: Admin approves.
 */

export async function reviewsOf(db: Db, assetId: string) {
  return db
    .select({
      reviewerId: assetReviews.reviewerId,
      reviewer: user.name,
      role: assetReviews.role,
      score: assetReviews.score,
      comment: assetReviews.comment,
      updatedAt: assetReviews.updatedAt,
    })
    .from(assetReviews)
    .innerJoin(user, eq(user.id, assetReviews.reviewerId))
    .where(eq(assetReviews.assetId, assetId))
    .orderBy(desc(assetReviews.updatedAt));
}

export async function saveReview(
  db: Db,
  v: {
    assetId: string;
    reviewerId: string;
    role: 'teacher' | 'admin';
    score: number;
    comment: string | null;
  },
) {
  await db
    .insert(assetReviews)
    .values(v)
    .onConflictDoUpdate({
      target: [assetReviews.assetId, assetReviews.reviewerId],
      set: { score: v.score, comment: v.comment, role: v.role, updatedAt: new Date() },
    });
}

/** Teacher scores across an offering's assets (each asset version reviewed counts once per teacher). */
export async function teacherStats(db: Db, offeringId: string) {
  const r = await db
    .select({
      reviews: sql<number>`count(*)`,
      assets: sql<number>`count(distinct ${assetReviews.assetId})`,
      teachers: sql<number>`count(distinct ${assetReviews.reviewerId})`,
      avg: sql<number | null>`avg(${assetReviews.score})`,
    })
    .from(assetReviews)
    .innerJoin(learningAssets, eq(learningAssets.id, assetReviews.assetId))
    .where(and(eq(learningAssets.offeringId, offeringId), eq(assetReviews.role, 'teacher')))
    .get();
  return {
    reviews: Number(r?.reviews ?? 0),
    assets: Number(r?.assets ?? 0),
    teachers: Number(r?.teachers ?? 0),
    averageScore: r?.avg == null ? null : Math.round(r.avg * 100) / 100,
  };
}

/** Per asset: number of teacher reviews and their average (for lists). */
export async function teacherScoresByAsset(db: Db, assetIds: string[]) {
  const out = new Map<string, { count: number; avg: number }>();
  // D1: at most 100 bound parameters per query.
  for (let i = 0; i < assetIds.length; i += 90) {
    const ids = assetIds.slice(i, i + 90);
    if (!ids.length) continue;
    const rows = await db
      .select({
        assetId: assetReviews.assetId,
        count: sql<number>`count(*)`,
        avg: sql<number>`avg(${assetReviews.score})`,
      })
      .from(assetReviews)
      .where(
        and(
          eq(assetReviews.role, 'teacher'),
          sql`${assetReviews.assetId} in (${sql.join(
            ids.map((x) => sql`${x}`),
            sql`, `,
          )})`,
        ),
      )
      .groupBy(assetReviews.assetId);
    for (const r of rows) out.set(r.assetId, { count: Number(r.count), avg: Number(r.avg) });
  }
  return out;
}
