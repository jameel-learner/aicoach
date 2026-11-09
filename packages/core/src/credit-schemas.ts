import { z } from 'zod';
import { LLM_TASK_IDS } from './llm';

/** A rupee amount as a decimal string (1 credit = ₹1), e.g. "8350" or "12.50". */
const creditAmount = z
  .string()
  .trim()
  .transform((v) => v.replace(/,/g, ''))
  .pipe(z.string().regex(/^\d{1,9}(\.\d{1,6})?$/, 'Enter an amount like 100 or 12.50'));
const positiveCreditAmount = creditAmount.refine(
  (v) => Number(v) > 0,
  'Amount must be more than 0',
);
const email = () => z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address'));

export const PAYMENT_KINDS = ['credit_purchase', 'onboarding_fee', 'platform_topup'] as const;
export const PAYMENT_METHODS = ['bank_transfer', 'upi', 'cash', 'cheque', 'card', 'other'] as const;

export const recordPaymentSchema = z
  .object({
    kind: z.enum(PAYMENT_KINDS),
    payerType: z.enum(['institution', 'user', 'platform']),
    institutionId: z.string().min(1).optional(),
    userEmail: email().optional(),
    /** Major units as a decimal string, e.g. "8350.00" rupees. */
    amount: z
      .string()
      .trim()
      .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter an amount like 8350 or 8350.50'),
    currency: z.enum(['INR', 'USD']),
    method: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().max(120).optional(),
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    note: z.string().trim().max(500).optional(),
  })
  .refine((p) => p.payerType !== 'institution' || !!p.institutionId, {
    message: 'Choose the institution',
    path: ['institutionId'],
  })
  .refine((p) => p.payerType !== 'user' || !!p.userEmail, {
    message: "Enter the payer's email",
    path: ['userEmail'],
  });

export const issueTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('institution'), institutionId: z.string().min(1) }),
  z.object({ type: z.literal('user'), email: email() }),
  z.object({ type: z.literal('platform') }),
]);

/** Admin issues new credits (backed by an offline payment) to a top-level wallet. */
export const issueCreditsSchema = z.object({
  target: issueTargetSchema,
  credits: positiveCreditAmount,
  paymentId: z.string().min(1).optional(),
  note: z.string().trim().max(500).optional(),
});

/** Giver transfers credits to a direct child wallet (POC → class, teacher → student). */
export const allotCreditsSchema = z.object({
  fromWalletId: z.string().min(1),
  toWalletId: z.string().min(1),
  credits: positiveCreditAmount,
  note: z.string().trim().max(500).optional(),
});

export const editAllotmentSchema = z.object({
  credits: creditAmount,
  reason: z.string().trim().min(3, 'Say why (e.g. typo)').max(300),
});

export const dailyCapSchema = z.object({ credits: creditAmount.nullable() });

export const feeSchema = z.object({ feeBps: z.number().int().min(0).max(5000) });

/** UPI UTR (12 digits) or NEFT/IMPS/RTGS reference (alphanumeric, up to 22) etc. */
export const utrSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6,30}$/, 'Enter the UTR / transaction reference (6–30 letters or digits)');

/**
 * Ask the level above for credits (decision 9.3-1). Omit walletId to use your own direct wallet
 * (which is funded by Admin). Requests that go to Admin must include the payment details.
 */
export const creditRequestSchema = z.object({
  walletId: z.string().min(1).optional(),
  credits: positiveCreditAmount,
  message: z.string().trim().max(500).optional(),
  payment: z
    .object({
      reference: utrSchema,
      method: z.enum(PAYMENT_METHODS).default('upi'),
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    })
    .optional(),
});

export const decideCreditRequestSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    /** Approve only: the amount to give (defaults to the requested amount). */
    credits: positiveCreditAmount.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((d) => d.decision !== 'reject' || (d.note?.length ?? 0) >= 3, {
    message: 'Say why the request is rejected',
    path: ['note'],
  });

/** USD→INR rate used to convert OpenRouter costs, e.g. "88.50" (Admin-only). */
export const usdInrRateSchema = z.object({
  rate: z
    .string()
    .trim()
    .regex(/^\d{2,3}(\.\d{1,2})?$/, 'Enter a rate like 88.50'),
});

export const registryUpdateSchema = z.object({
  primaryModel: z.string().trim().min(3).max(120),
  fallbackModels: z.array(z.string().trim().min(3).max(120)).max(3).default([]),
  maxTokens: z.number().int().min(16).max(64_000).nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
});

export const modelSelectableSchema = z.object({ selectable: z.boolean() });

export const playgroundSchema = z.object({
  task: z.enum(LLM_TASK_IDS as [string, ...string[]]).default('playground'),
  prompt: z.string().trim().min(1).max(4000),
  /** Teacher: which class wallet pays. Omit to use your own wallet. */
  classGroupId: z.string().min(1).optional(),
  maxTokens: z.number().int().min(16).max(4000).default(400),
});

// ---------------------------------------------------------------- Phase 2: textbooks

export const bookMetaSchema = z.object({
  title: z.string().trim().min(3, 'Enter the book title').max(200),
  offeringId: z.string().min(1, 'Choose the board · class · subject'),
  edition: z.string().trim().max(60).optional(),
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2}$/, 'Use a 2-letter language code like en')
    .default('en'),
});

/** Admin review of one parsed page: corrected Markdown (optional) and approval. */
export const updateBookPageSchema = z.object({
  markdown: z.string().max(60_000).optional(),
});

export const mapBookInstitutionsSchema = z.object({
  institutionIds: z.array(z.string().min(1)).max(90),
});

/** "Ask your textbook" (Phase 2). */
export const askSchema = z.object({
  question: z.string().trim().min(3, 'Type a question').max(1000),
  enrolmentId: z.string().min(1).optional(),
  classGroupId: z.string().min(1).optional(),
  bookIds: z.array(z.string().min(1)).max(20).optional(),
  forceNew: z.boolean().default(false),
  /** Admin only (eval runs): answer with this model instead of the registry's tutor model. */
  model: z.string().trim().min(3).max(120).optional(),
  /** false → one JSON response (eval runner, simple clients). */
  stream: z.boolean().default(true),
});

/** Eval harness (evals/): judge one answer, and store a run's scores. */
export const evalJudgeSchema = z.object({
  question: z.string().min(1).max(2000),
  reference: z.string().min(1).max(4000),
  answer: z.string().max(12_000),
});
export const evalRunSchema = z.object({
  model: z.string().min(3).max(120),
  promptVersion: z.string().min(1).max(60),
  questions: z.number().int().min(1),
  citationAccuracy: z.number().min(0).max(1),
  correctness: z.number().min(0).max(1),
  notes: z.string().max(500).optional(),
  details: z.array(z.unknown()).max(500).optional(),
});
