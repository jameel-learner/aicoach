/**
 * D1 schema v1 (Phase 0). Architecture §5.3.
 * Auth tables follow Better Auth's expected model/field names (user, session, account, verification, twoFactor, rateLimit).
 * Domain tables use snake_case columns.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`);
const updatedAt = () =>
  integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`)
    .$onUpdate(() => new Date());

// =====================================================================
// Auth (Better Auth)
// =====================================================================

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  // twoFactor plugin
  twoFactorEnabled: integer('two_factor_enabled', { mode: 'boolean' }).notNull().default(false),
  // App fields
  role: text('role', { enum: ['admin', 'institution_poc', 'teacher', 'student'] })
    .notNull()
    .default('student'),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

export const twoFactor = sqliteTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: integer('verified', { mode: 'boolean' }).default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: integer('locked_until', { mode: 'timestamp_ms' }),
  },
  (t) => [index('two_factor_user_idx').on(t.userId), index('two_factor_secret_idx').on(t.secret)],
);

export const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
});

// =====================================================================
// Curriculum taxonomy (architecture §2.1, spec 4.3)
// =====================================================================

export const boards = sqliteTable('boards', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

/** A class/grade/semester within a board, e.g. KSEAB "2nd PUC". */
export const levels = sqliteTable(
  'levels',
  {
    id: id(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('levels_board_code_uq').on(t.boardId, t.code)],
);

export const subjects = sqliteTable('subjects', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  stream: text('stream', { enum: ['science', 'commerce', 'arts', 'other'] }).notNull(),
  createdAt: createdAt(),
});

/** Board × level × subject: the unit that books, strategies and enrolments attach to. */
export const subjectOfferings = sqliteTable(
  'subject_offerings',
  {
    id: id(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id),
    levelId: text('level_id')
      .notNull()
      .references(() => levels.id),
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('offering_uq').on(t.boardId, t.levelId, t.subjectId)],
);

// =====================================================================
// Institutions, classes, enrolments
// =====================================================================

export const institutions = sqliteTable('institutions', {
  id: id(),
  name: text('name').notNull(),
  type: text('type', { enum: ['school', 'college', 'university'] }).notNull(),
  city: text('city'),
  status: text('status', { enum: ['active', 'suspended'] })
    .notNull()
    .default('active'),
  createdAt: createdAt(),
});

export const institutionPocs = sqliteTable(
  'institution_pocs',
  {
    institutionId: text('institution_id')
      .notNull()
      .references(() => institutions.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.institutionId, t.userId] })],
);

/** A class (section) inside an institution for one subject offering, managed by a class teacher. */
export const classGroups = sqliteTable(
  'class_groups',
  {
    id: id(),
    institutionId: text('institution_id')
      .notNull()
      .references(() => institutions.id),
    offeringId: text('offering_id')
      .notNull()
      .references(() => subjectOfferings.id),
    name: text('name').notNull(),
    academicYear: text('academic_year').notNull(),
    classTeacherId: text('class_teacher_id').references(() => user.id),
    joinCode: text('join_code').notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [index('class_groups_inst_idx').on(t.institutionId)],
);

export const enrolments = sqliteTable(
  'enrolments',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    roleIn: text('role_in', { enum: ['student', 'teacher'] }).notNull(),
    offeringId: text('offering_id')
      .notNull()
      .references(() => subjectOfferings.id),
    /** Null for direct (non-institution) enrolment, decision 6.3. */
    institutionId: text('institution_id').references(() => institutions.id),
    classGroupId: text('class_group_id').references(() => classGroups.id),
    status: text('status', { enum: ['active', 'removed'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
  },
  (t) => [
    index('enrolments_user_idx').on(t.userId),
    index('enrolments_class_idx').on(t.classGroupId),
    // One enrolment per user per class, and one direct enrolment per user per offering.
    uniqueIndex('enrolments_user_class_uq').on(t.userId, t.offeringId, t.classGroupId),
    // SQLite treats NULLs as distinct, so direct enrolments need their own partial index.
    uniqueIndex('enrolments_user_direct_uq')
      .on(t.userId, t.offeringId)
      .where(sql`${t.classGroupId} IS NULL`),
  ],
);

// =====================================================================
// Parent contact, consent, audit
// =====================================================================

export const parentContacts = sqliteTable('parent_contacts', {
  id: id(),
  studentId: text('student_id')
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  relationship: text('relationship').notNull(),
  consentStatus: text('consent_status', { enum: ['pending', 'verified', 'revoked'] })
    .notNull()
    .default('pending'),
  /** SHA-256 of the one-time consent token emailed to the parent. */
  consentTokenHash: text('consent_token_hash'),
  consentRequestedAt: integer('consent_requested_at', { mode: 'timestamp_ms' }),
  consentVerifiedAt: integer('consent_verified_at', { mode: 'timestamp_ms' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const consents = sqliteTable(
  'consents',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: ['terms', 'privacy', 'safety_parent_alerts', 'parent_data_processing'],
    }).notNull(),
    version: text('version').notNull(),
    grantedBy: text('granted_by', { enum: ['self', 'parent'] }).notNull(),
    grantedAt: integer('granted_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('consents_user_idx').on(t.userId)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    data: text('data', { mode: 'json' }),
    createdAt: createdAt(),
  },
  (t) => [index('audit_entity_idx').on(t.entity, t.entityId)],
);
