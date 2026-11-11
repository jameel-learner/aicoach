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
    /** Reconciliation (hourly cron): OpenRouter's own record of the cost, checked later. */
    reconciledAt: integer('reconciled_at', { mode: 'timestamp_ms' }),
    reconciledUsdNano: integer('reconciled_usd_nano'),
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

// =====================================================================
// Phase 2: Textbooks (architecture §3.3–3.4, decisions 9.2-1 and 9.4-1).
// Content is processed once into the SHARED content store (R2 package + Vectorize); each
// environment keeps its own copy of the rows below (ingested here, or imported from the package).
// Full-text search: virtual table `chunks_fts` (FTS5), created in the migration by hand.
// =====================================================================

export const books = sqliteTable('books', {
  /** Global id: the same in every environment that imports the book. */
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  offeringId: text('offering_id')
    .notNull()
    .references(() => subjectOfferings.id),
  edition: text('edition'),
  language: text('language').notNull().default('en'),
  pageCount: integer('page_count').notNull().default(0),
  /** uploaded → splitting → parsing → review → publishing → published (or failed). */
  status: text('status', {
    enum: ['uploaded', 'splitting', 'parsing', 'review', 'publishing', 'published', 'failed'],
  })
    .notNull()
    .default('uploaded'),
  statusMessage: text('status_message'),
  /** Latest published version in the shared store, e.g. "v1" (null until published). */
  publishedVersion: text('published_version'),
  /** Version the next publish will create. */
  nextVersion: integer('next_version').notNull().default(1),
  /** ingested here, or imported from the shared store. */
  source: text('source', { enum: ['ingested', 'imported'] })
    .notNull()
    .default('ingested'),
  workflowId: text('workflow_id'),
  /** textbook (searched by Ask) or board_material (blueprints, papers, schemes…; decision 9.5-2). */
  kind: text('kind', { enum: ['textbook', 'board_material'] })
    .notNull()
    .default('textbook'),
  /** Board material only. */
  category: text('category', {
    enum: ['blueprint', 'model_paper', 'board_paper', 'scheme', 'question_bank', 'answer_script'],
  }),
  /** Academic year of board material, e.g. "2026-27". */
  academicYear: text('academic_year'),
  /** A scheme of evaluation → the paper it answers. */
  relatedBookId: text('related_book_id'),
  /** Original page numbers removed before storing (e.g. answer-script cover pages). */
  removedPages: text('removed_pages', { mode: 'json' }).$type<number[]>(),
  /** Why pages were removed, per range of ORIGINAL page numbers, e.g. [{ pages: "2-8", why: "Kannada version" }]. */
  removedReasons: text('removed_reasons', { mode: 'json' }).$type<
    { pages: string; why: string }[]
  >(),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const bookPages = sqliteTable(
  'book_pages',
  {
    bookId: text('book_id')
      .notNull()
      .references(() => books.id),
    pageNo: integer('page_no').notNull(),
    markdown: text('markdown'),
    /** pending → parsed | failed; Admin review: approved | edited. */
    status: text('status', { enum: ['pending', 'parsed', 'failed', 'approved', 'edited'] })
      .notNull()
      .default('pending'),
    /** Automatic quality flags for review (e.g. "empty", "short", "garbled"). */
    flags: text('flags', { mode: 'json' }).$type<string[]>(),
    error: text('error'),
    costUsdNano: integer('cost_usd_nano').notNull().default(0),
    updatedBy: text('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.pageNo] })],
);

/** Retrieval units. id = `<bookId>:<version>:<chunkNo>` (also the Vectorize vector id). */
export const chunks = sqliteTable(
  'chunks',
  {
    id: text('id').primaryKey(),
    bookId: text('book_id')
      .notNull()
      .references(() => books.id),
    version: text('version').notNull(),
    chunkNo: integer('chunk_no').notNull(),
    pageFrom: integer('page_from').notNull(),
    pageTo: integer('page_to').notNull(),
    /** Nearest heading above the chunk (e.g. "1.5.3 Interest on Drawings"). */
    section: text('section'),
    text: text('text').notNull(),
  },
  (t) => [index('chunks_book_idx').on(t.bookId, t.version, t.chunkNo)],
);

/** Which books an institution's learners use, per subject offering (decision 9.2-1). */
export const institutionBooks = sqliteTable(
  'institution_books',
  {
    institutionId: text('institution_id')
      .notNull()
      .references(() => institutions.id),
    bookId: text('book_id')
      .notNull()
      .references(() => books.id),
    mappedBy: text('mapped_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.institutionId, t.bookId] })],
);

/**
 * Answer cache (spec 1.3–1.4, architecture §3.6). Per environment. A question asked again in the
 * same scope (same books + answer profile) returns the stored answer at no cost; "force new"
 * creates another variant.
 */
export const answers = sqliteTable(
  'answers',
  {
    id: id(),
    /** Sorted book tags + answer profile, e.g. "<bookId>@v1|default". */
    scopeKey: text('scope_key').notNull(),
    question: text('question').notNull(),
    questionNorm: text('question_norm').notNull(),
    embedding: text('embedding', { mode: 'json' }).$type<number[]>().notNull(),
    answer: text('answer').notNull(),
    citations: text('citations', { mode: 'json' }).$type<unknown[]>().notNull(),
    notInBook: integer('not_in_book', { mode: 'boolean' }).notNull().default(false),
    variantNo: integer('variant_no').notNull().default(1),
    model: text('model'),
    promptVersion: text('prompt_version').notNull(),
    /**
     * What produced it: the CONFIGURED tutor model + prompt version, e.g.
     * "google/gemini-2.5-flash|tutor_answer@1". Only answers of the current generator are reused,
     * so a model switch or prompt change takes effect at once (switching back reuses them again).
     */
    generator: text('generator').notNull().default(''),
    /** Set by "Stop reusing" (Admin): kept as history, never served again. */
    retiredAt: integer('retired_at', { mode: 'timestamp_ms' }),
    createdBy: text('created_by'),
    hits: integer('hits').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('answers_scope_idx').on(t.scopeKey, t.createdAt),
    index('answers_norm_idx').on(t.scopeKey, t.generator, t.questionNorm),
  ],
);

/** Eval harness results (evals/), shown on the Admin Models screen. */
export const evalRuns = sqliteTable('eval_runs', {
  id: id(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  questions: integer('questions').notNull(),
  citationAccuracy: real('citation_accuracy').notNull(),
  correctness: real('correctness').notNull(),
  notes: text('notes'),
  details: text('details', { mode: 'json' }).$type<unknown[]>(),
  createdBy: text('created_by'),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- Phase 3: exam strategy

/**
 * One compile run = one strategy version per subject offering (architecture §3.5, decision 9.5-2).
 * compiling → draft (Admin reviews) → approved (the one journeys read) → superseded; or failed.
 */
export const examStrategies = sqliteTable(
  'exam_strategies',
  {
    id: id(),
    offeringId: text('offering_id')
      .notNull()
      .references(() => subjectOfferings.id),
    version: integer('version').notNull(),
    status: text('status', {
      enum: ['compiling', 'draft', 'approved', 'superseded', 'failed'],
    })
      .notNull()
      .default('compiling'),
    statusMessage: text('status_message'),
    /** Step progress for the UI, e.g. { step: 'papers', done: 5, total: 13 }. */
    progress: text('progress', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** The compiled ExamStrategy (packages/core/src/strategy.ts); null while compiling. */
    strategy: text('strategy', { mode: 'json' }).$type<unknown>(),
    /** Board documents used (ids), fixed when the run starts. */
    sourceBookIds: text('source_book_ids', { mode: 'json' }).$type<string[]>().notNull(),
    costUsdNano: integer('cost_usd_nano').notNull().default(0),
    promptVersion: text('prompt_version').notNull(),
    workflowId: text('workflow_id'),
    reviewNote: text('review_note'),
    createdBy: text('created_by').notNull(),
    approvedBy: text('approved_by'),
    approvedAt: integer('approved_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('exam_strategies_version_uq').on(t.offeringId, t.version)],
);

/** Questions found in board material by a compile run (tagged; schemes merged in). */
export const boardItems = sqliteTable(
  'board_items',
  {
    id: id(),
    strategyId: text('strategy_id')
      .notNull()
      .references(() => examStrategies.id),
    bookId: text('book_id')
      .notNull()
      .references(() => books.id),
    /** Page of the stored document. */
    page: integer('page'),
    source: text('source', {
      enum: ['board_exam', 'model_paper', 'practice_paper', 'bank'],
    }).notNull(),
    paperLabel: text('paper_label'),
    examYear: integer('exam_year'),
    qno: text('qno').notNull(),
    part: text('part', { enum: ['A', 'B', 'C', 'D'] }),
    marks: integer('marks'),
    chapter: integer('chapter'),
    topic: text('topic').notNull(),
    /** Canonical topic after merging similar wording (step "topics"). */
    topicGroup: text('topic_group'),
    typology: text('typology').notNull(),
    cognitive: text('cognitive'),
    difficulty: text('difficulty'),
    text: text('text').notNull(),
    answer: text('answer'),
    markSplit: text('mark_split'),
    markingPoints: text('marking_points', { mode: 'json' }).$type<
      { point: string; marks: number }[]
    >(),
    createdAt: createdAt(),
  },
  (t) => [
    index('board_items_strategy_idx').on(t.strategyId, t.chapter),
    index('board_items_book_idx').on(t.strategyId, t.bookId),
  ],
);

// ---------------------------------------------------------------- Phase 3: learning material

/** One generation run (a set of slots, e.g. all notes of chapters 3 and 9). LOCAL only. */
export const generationRuns = sqliteTable('generation_runs', {
  id: id(),
  offeringId: text('offering_id')
    .notNull()
    .references(() => subjectOfferings.id),
  /** The approved strategy version the material follows. */
  strategyId: text('strategy_id')
    .notNull()
    .references(() => examStrategies.id),
  kind: text('kind', { enum: ['note', 'cards', 'questions', 'graph'] }).notNull(),
  /** Chapters in scope (null = all). */
  chapters: text('chapters', { mode: 'json' }).$type<number[] | null>(),
  status: text('status', { enum: ['running', 'done', 'failed'] })
    .notNull()
    .default('running'),
  statusMessage: text('status_message'),
  /** { done, total, label, checkpoints } (finished slots are skipped when continuing). */
  progress: text('progress', { mode: 'json' }).$type<Record<string, unknown>>(),
  costUsdNano: integer('cost_usd_nano').notNull().default(0),
  workflowId: text('workflow_id'),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A generated learning asset (decision 9.5-4): stable slot + version. draft → approved (what learners
 * see) → superseded by the next approved version; or rejected.
 */
export const learningAssets = sqliteTable(
  'learning_assets',
  {
    id: id(),
    offeringId: text('offering_id')
      .notNull()
      .references(() => subjectOfferings.id),
    slotKey: text('slot_key').notNull(),
    version: integer('version').notNull(),
    kind: text('kind', { enum: ['note', 'cards', 'questions', 'graph'] }).notNull(),
    chapter: integer('chapter').notNull(),
    topic: text('topic').notNull(),
    marks: integer('marks').notNull(),
    status: text('status', { enum: ['draft', 'approved', 'rejected', 'superseded'] })
      .notNull()
      .default('draft'),
    /** The asset (e.g. NoteDraft, packages/core/src/assets.ts). */
    content: text('content', { mode: 'json' }).$type<unknown>().notNull(),
    critique: text('critique', { mode: 'json' }).$type<unknown>(),
    checks: text('checks', { mode: 'json' }).$type<unknown[]>().notNull(),
    /** Textbook excerpts it may cite ([S#] → book/page). */
    sources: text('sources', { mode: 'json' }).$type<unknown[]>().notNull(),
    /** "writer model|critic model|prompt version" (regenerate before production: decision 9.5-4). */
    generator: text('generator').notNull(),
    fixed: integer('fixed', { mode: 'boolean' }).notNull().default(false),
    strategyId: text('strategy_id').references(() => examStrategies.id),
    runId: text('run_id').references(() => generationRuns.id),
    costUsdNano: integer('cost_usd_nano').notNull().default(0),
    /** Reviewer's rubric score 1-5 (Phase 3 exit: ≥ 4 on a sample) and note. */
    reviewScore: integer('review_score'),
    reviewNote: text('review_note'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('learning_assets_slot_version_uq').on(t.slotKey, t.version),
    index('learning_assets_offering_idx').on(t.offeringId, t.kind, t.chapter, t.status),
  ],
);

/** A teacher's (or Admin's) rubric score and comment on a generated asset (Phase 3 exit: ≥ 4/5). */
export const assetReviews = sqliteTable(
  'asset_reviews',
  {
    id: id(),
    assetId: text('asset_id')
      .notNull()
      .references(() => learningAssets.id),
    reviewerId: text('reviewer_id')
      .notNull()
      .references(() => user.id),
    role: text('role', { enum: ['teacher', 'admin'] }).notNull(),
    score: integer('score').notNull(),
    comment: text('comment'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('asset_reviews_asset_reviewer_uq').on(t.assetId, t.reviewerId),
    index('asset_reviews_asset_idx').on(t.assetId),
  ],
);
