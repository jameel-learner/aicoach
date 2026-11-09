import {
  boards,
  books,
  classGroups,
  enrolments,
  institutionBooks,
  institutionPocs,
  levels,
  subjectOfferings,
  subjects,
  type Db,
} from '@aicoach/db';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import {
  classWallet,
  directUserWallet,
  institutionWallet,
  platformWallet,
  studentClassWallet,
  type Wallet,
} from '../credits/wallets';
import type { SessionUser } from '../env';
import { badRequest, forbidden } from '../lib/http';
import { bookTag } from './store';

/**
 * "Ask your textbook" scope: which books a question searches and which wallets pay for it.
 *  - Student: the enrolment's institution books for that subject (decision 9.2-1); self-study or
 *    unmapped → every published book for the subject. Pays: student's class wallet, then own.
 *  - Teacher: the class's institution books; pays the class wallet, then own (as in Phase 1).
 *  - POC: their institution's books; pays the institution wallet.
 *  - Admin: chosen books (default all); pays the platform wallet at cost.
 */

export interface ScopeBook {
  id: string;
  title: string;
  version: string;
  tag: string;
}
export interface AskScope {
  books: ScopeBook[];
  payers: Wallet[];
  subject: string;
  /** What the learner is studying in (for the UI). */
  context: { enrolmentId?: string; classGroupId?: string; label: string };
}
export interface ScopeInput {
  enrolmentId?: string;
  classGroupId?: string;
  bookIds?: string[];
}

async function publishedBooks(db: Db, where: { offeringId?: string; ids?: string[] }) {
  const conds = [isNotNull(books.publishedVersion)];
  if (where.offeringId) conds.push(eq(books.offeringId, where.offeringId));
  if (where.ids) conds.push(inArray(books.id, where.ids.slice(0, 50)));
  const rows = await db
    .select({ id: books.id, title: books.title, version: books.publishedVersion })
    .from(books)
    .where(and(...conds));
  return rows.map((b) => ({
    id: b.id,
    title: b.title,
    version: b.version!,
    tag: bookTag(b.id, b.version!),
  }));
}

/** The institution's mapped books for an offering; falls back to every published book for it. */
async function institutionBooksFor(db: Db, institutionId: string | null, offeringId: string) {
  if (institutionId) {
    const mapped = await db
      .select({ id: institutionBooks.bookId })
      .from(institutionBooks)
      .innerJoin(books, eq(books.id, institutionBooks.bookId))
      .where(
        and(eq(institutionBooks.institutionId, institutionId), eq(books.offeringId, offeringId)),
      );
    if (mapped.length) return publishedBooks(db, { ids: mapped.map((m) => m.id) });
  }
  return publishedBooks(db, { offeringId });
}

async function subjectLabel(db: Db, offeringId: string) {
  const r = await db
    .select({ board: boards.code, level: levels.name, subject: subjects.name })
    .from(subjectOfferings)
    .innerJoin(boards, eq(boards.id, subjectOfferings.boardId))
    .innerJoin(levels, eq(levels.id, subjectOfferings.levelId))
    .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
    .where(eq(subjectOfferings.id, offeringId))
    .get();
  return r ? `${r.board} ${r.level} ${r.subject}` : 'your subject';
}

export async function askScope(db: Db, me: SessionUser, input: ScopeInput): Promise<AskScope> {
  if (me.role === 'admin') {
    const list = await publishedBooks(db, input.bookIds?.length ? { ids: input.bookIds } : {});
    return {
      books: list,
      payers: [await platformWallet(db)],
      subject: 'school',
      context: { label: 'All published books' },
    };
  }

  if (me.role === 'student') {
    const mine = await db
      .select()
      .from(enrolments)
      .where(
        and(
          eq(enrolments.userId, me.id),
          eq(enrolments.roleIn, 'student'),
          eq(enrolments.status, 'active'),
        ),
      );
    // An unknown id (e.g. the phone still remembers a subject from another account, or one that
    // was removed) falls back to the student's first subject; another user's enrolment is never used.
    let e = input.enrolmentId ? mine.find((x) => x.id === input.enrolmentId) : mine[0];
    if (!e && mine[0]) {
      console.warn(
        `ask scope: enrolment ${input.enrolmentId} is not an active enrolment of ${me.id}; using their first`,
      );
      e = mine[0];
    }
    if (!e) throw badRequest('Join a class or choose a subject first');
    const payers = e.classGroupId
      ? [await studentClassWallet(db, me.id, e.classGroupId), await directUserWallet(db, me.id)]
      : [await directUserWallet(db, me.id)];
    return {
      books: await institutionBooksFor(db, e.institutionId, e.offeringId),
      payers,
      subject: await subjectLabel(db, e.offeringId),
      context: { enrolmentId: e.id, label: await subjectLabel(db, e.offeringId) },
    };
  }

  if (me.role === 'teacher') {
    const taught = await db
      .select({
        id: classGroups.id,
        name: classGroups.name,
        institutionId: classGroups.institutionId,
        offeringId: classGroups.offeringId,
      })
      .from(classGroups)
      .where(
        or(
          eq(classGroups.classTeacherId, me.id),
          inArray(
            classGroups.id,
            db
              .select({ id: enrolments.classGroupId })
              .from(enrolments)
              .where(
                and(
                  eq(enrolments.userId, me.id),
                  eq(enrolments.roleIn, 'teacher'),
                  eq(enrolments.status, 'active'),
                ),
              ),
          ),
        ),
      );
    const cls = input.classGroupId ? taught.find((c) => c.id === input.classGroupId) : taught[0];
    if (input.classGroupId && !cls) throw forbidden('You do not teach this class');
    if (!cls) {
      return {
        books: await publishedBooks(db, {}),
        payers: [await directUserWallet(db, me.id)],
        subject: 'school',
        context: { label: 'All published books (no class yet)' },
      };
    }
    return {
      books: await institutionBooksFor(db, cls.institutionId, cls.offeringId),
      payers: [await classWallet(db, cls.id), await directUserWallet(db, me.id)],
      subject: await subjectLabel(db, cls.offeringId),
      context: { classGroupId: cls.id, label: cls.name },
    };
  }

  // Institution POC
  const inst = await db
    .select({ id: institutionPocs.institutionId })
    .from(institutionPocs)
    .where(eq(institutionPocs.userId, me.id))
    .get();
  if (!inst) throw forbidden();
  const mapped = await db
    .select({ id: institutionBooks.bookId })
    .from(institutionBooks)
    .where(eq(institutionBooks.institutionId, inst.id));
  return {
    books: mapped.length ? await publishedBooks(db, { ids: mapped.map((m) => m.id) }) : [],
    payers: [await institutionWallet(db, inst.id)],
    subject: 'school',
    context: { label: "Your institution's books" },
  };
}
