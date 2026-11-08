/**
 * D1 schema v1 (Phase 0). Architecture §5.3.
 * Auth tables follow Better Auth's expected model/field names (user, session, account, verification, twoFactor, rateLimit).
 * Domain tables use snake_case columns.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
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

// =====================================================================
// Phase 1: LLM models & registry (architecture §6.5)
// =====================================================================

export const platformSettings = sqliteTable('platform_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: updatedAt(),
});

/** Catalog synced from OpenRouter /models. Prices in pico-USD per token (exact integers). */
export const llmModels = sqliteTable('llm_models', {
  id: text('id').primaryKey(), // OpenRouter slug, e.g. google/gemini-2.5-flash
  name: text('name').notNull(),
  contextLength: integer('context_length'),
  pricePromptPico: integer('price_prompt_pico').notNull().default(0),
  priceCompletionPico: integer('price_completion_pico').notNull().default(0),
  inputModalities: text('input_modalities', { mode: 'json' }).$type<string[]>().notNull(),
  supportsJson: integer('supports_json', { mode: 'boolean' }).notNull().default(false),
  /** Shown as an option in the Admin model picker. */
  selectable: integer('selectable', { mode: 'boolean' }).notNull().default(false),
  /** False when the model disappeared from OpenRouter's list at the last sync. */
  available: integer('available', { mode: 'boolean' }).notNull().default(true),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }),
});

/** Which model serves each task. Missing rows fall back to the code default. */
export const modelRegistry = sqliteTable('model_registry', {
  task: text('task').primaryKey(),
  primaryModel: text('primary_model').notNull(),
  fallbackModels: text('fallback_models', { mode: 'json' }).$type<string[]>().notNull(),
  maxTokens: integer('max_tokens'),
  temperature: real('temperature'),
  updatedBy: text('updated_by'),
  updatedAt: updatedAt(),
});

// =====================================================================
// Phase 1: Credits (architecture §6.6). Wallet money is integer micro-INR; 1 credit = ₹1 = 1e6 micro.
// Provider (OpenRouter) cost is integer nano-USD.
// =====================================================================

export const wallets = sqliteTable(
  'wallets',
  {
    id: id(),
    ownerType: text('owner_type', { enum: ['platform', 'institution', 'class', 'user'] }).notNull(),
    institutionId: text('institution_id').references(() => institutions.id),
    classGroupId: text('class_group_id').references(() => classGroups.id),
    userId: text('user_id').references(() => user.id),
    parentWalletId: text('parent_wallet_id'),
    /** Materialised path, e.g. /p/i:<inst>/c:<class>/u:<user>. Deterministic, so also the identity. */
    path: text('path').notNull().unique(),
    balanceMicro: integer('balance_micro').notNull().default(0),
    heldMicro: integer('held_micro').notNull().default(0),
    /** Optional per-day spending cap (set by the giver, e.g. teacher for a student). */
    dailyCapMicro: integer('daily_cap_micro'),
    createdAt: createdAt(),
  },
  (t) => [
    index('wallets_parent_idx').on(t.parentWalletId),
    index('wallets_user_idx').on(t.userId),
    // The database itself refuses any change that would overspend: available = balance - held >= 0.
    check('wallet_funds_ok', sql`${t.heldMicro} >= 0 AND ${t.balanceMicro} >= ${t.heldMicro}`),
  ],
);

export const payments = sqliteTable(
  'payments',
  {
    id: id(),
    kind: text('kind', { enum: ['credit_purchase', 'onboarding_fee', 'platform_topup'] }).notNull(),
    payerType: text('payer_type', { enum: ['institution', 'user', 'platform'] }).notNull(),
    institutionId: text('institution_id').references(() => institutions.id),
    userId: text('user_id').references(() => user.id),
    /** Amount actually paid, in minor units (paise for INR, cents for USD). */
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency', { enum: ['INR', 'USD'] }).notNull(),
    method: text('method').notNull(),
    reference: text('reference'),
    paidOn: text('paid_on').notNull(), // YYYY-MM-DD
    note: text('note'),
    /** Who created the record: Admin, or the payer when submitted with a credit request. */
    recordedBy: text('recorded_by').notNull(),
    /** Payer-submitted payments start pending until Admin checks the UTR (decision 9.3-1). */
    status: text('status', { enum: ['pending', 'verified', 'rejected'] })
      .notNull()
      .default('verified'),
    verifiedBy: text('verified_by'),
    verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_inst_idx').on(t.institutionId),
    index('payments_reference_idx').on(t.reference),
    index('payments_status_idx').on(t.status),
  ],
);

/**
 * A transfer of credits down the tree (or an Admin issuance when fromWalletId is null).
 * Lifecycle: open (giver may edit; an edit clears the acknowledgement) → acknowledged by receiver → locked by giver.
 */
export const allotments = sqliteTable(
  'allotments',
  {
    id: id(),
    fromWalletId: text('from_wallet_id').references(() => wallets.id),
    toWalletId: text('to_wallet_id')
      .notNull()
      .references(() => wallets.id),
    amountMicro: integer('amount_micro').notNull(),
    status: text('status', { enum: ['open', 'locked'] })
      .notNull()
      .default('open'),
    paymentId: text('payment_id').references(() => payments.id),
    note: text('note'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp_ms' }),
    acknowledgedBy: text('acknowledged_by'),
    lockedAt: integer('locked_at', { mode: 'timestamp_ms' }),
    lockedBy: text('locked_by'),
  },
  (t) => [
    index('allotments_to_idx').on(t.toWalletId),
    index('allotments_from_idx').on(t.fromWalletId),
  ],
);

export const allotmentEdits = sqliteTable(
  'allotment_edits',
  {
    id: id(),
    allotmentId: text('allotment_id')
      .notNull()
      .references(() => allotments.id),
    oldAmountMicro: integer('old_amount_micro').notNull(),
    newAmountMicro: integer('new_amount_micro').notNull(),
    reason: text('reason'),
    editedBy: text('edited_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('allotment_edits_allotment_idx').on(t.allotmentId)],
);

/** Append-only. A wallet's balance always equals the sum of its entries. */
export const ledgerEntries = sqliteTable(
  'ledger_entries',
  {
    id: id(),
    walletId: text('wallet_id')
      .notNull()
      .references(() => wallets.id),
    type: text('type', {
      enum: ['issue', 'allot_in', 'allot_out', 'edit_in', 'edit_out', 'usage', 'adjust'],
    }).notNull(),
    /** Signed: positive = credits in, negative = credits out. */
    amountMicro: integer('amount_micro').notNull(),
    allotmentId: text('allotment_id'),
    usageId: text('usage_id'),
    memo: text('memo'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('ledger_wallet_idx').on(t.walletId, t.createdAt)],
);

export const creditHolds = sqliteTable(
  'credit_holds',
  {
    id: id(),
    walletId: text('wallet_id')
      .notNull()
      .references(() => wallets.id),
    amountMicro: integer('amount_micro').notNull(),
    requestId: text('request_id').notNull().unique(),
    status: text('status', { enum: ['held', 'settled', 'released', 'expired'] })
      .notNull()
      .default('held'),
    createdAt: createdAt(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('holds_status_idx').on(t.status, t.expiresAt)],
);

/** One row per metered LLM call. */
export const llmUsage = sqliteTable(
  'llm_usage',
  {
    id: id(),
    requestId: text('request_id').notNull().unique(),
    generationId: text('generation_id'),
    walletId: text('wallet_id')
      .notNull()
      .references(() => wallets.id),
    userId: text('user_id'),
    task: text('task').notNull(),
    modelRequested: text('model_requested').notNull(),
    modelUsed: text('model_used'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    rawUsdNano: integer('raw_usd_nano').notNull().default(0),
    feeBps: integer('fee_bps').notNull(),
    /** USD→INR rate (paise per US$) used to convert this call. */
    usdInrPaise: integer('usd_inr_paise').notNull(),
    billedMicro: integer('billed_micro').notNull().default(0),
    cacheStatus: text('cache_status', { enum: ['miss', 'hit'] })
      .notNull()
      .default('miss'),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    errorMessage: text('error_message'),
    latencyMs: integer('latency_ms'),
    createdAt: createdAt(),
  },
  (t) => [
    index('usage_wallet_idx').on(t.walletId, t.createdAt),
    index('usage_generation_idx').on(t.generationId),
  ],
);

/**
 * A request for credits from the level above (decision 9.3-1). Requests to Admin carry a
 * payment (UTR) that Admin verifies; approval issues/allots credits automatically.
 */
export const creditRequests = sqliteTable(
  'credit_requests',
  {
    id: id(),
    /** The requester's wallet (receives the credits). */
    walletId: text('wallet_id')
      .notNull()
      .references(() => wallets.id),
    /** The wallet the credits come from (its managers decide). Null-parent wallets can't request. */
    parentWalletId: text('parent_wallet_id')
      .notNull()
      .references(() => wallets.id),
    toAdmin: integer('to_admin', { mode: 'boolean' }).notNull(),
    requestedBy: text('requested_by').notNull(),
    amountMicro: integer('amount_micro').notNull(),
    message: text('message'),
    paymentId: text('payment_id').references(() => payments.id),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'cancelled'] })
      .notNull()
      .default('pending'),
    grantedMicro: integer('granted_micro'),
    allotmentId: text('allotment_id').references(() => allotments.id),
    decidedBy: text('decided_by'),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
    decisionNote: text('decision_note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('credit_requests_wallet_idx').on(t.walletId, t.createdAt),
    index('credit_requests_parent_idx').on(t.parentWalletId, t.status),
  ],
);
