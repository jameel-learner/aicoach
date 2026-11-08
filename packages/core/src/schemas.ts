import { z } from 'zod';
import { ROLES } from './roles';

const trimmed = (max: number) => z.string().trim().min(1).max(max);
/** Trim + lowercase first, then validate (mobile keyboards often add a trailing space). */
const email = () => z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address'));
const code = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, - or _ only');

// ---------- Taxonomy (Admin) ----------
export const createBoardSchema = z.object({ code, name: trimmed(120) });
export const createLevelSchema = z.object({
  boardId: z.string().min(1),
  code,
  name: trimmed(60),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export const SUBJECT_STREAMS = ['science', 'commerce', 'arts', 'other'] as const;
export const createSubjectSchema = z.object({
  code,
  name: trimmed(120),
  stream: z.enum(SUBJECT_STREAMS),
});
export const createOfferingSchema = z.object({
  boardId: z.string().min(1),
  levelId: z.string().min(1),
  subjectId: z.string().min(1),
});

// ---------- Institutions ----------
export const INSTITUTION_TYPES = ['school', 'college', 'university'] as const;
export const createInstitutionSchema = z.object({
  name: trimmed(160),
  type: z.enum(INSTITUTION_TYPES),
  city: trimmed(80).optional(),
});
export const updateInstitutionSchema = createInstitutionSchema.partial().extend({
  status: z.enum(['active', 'suspended']).optional(),
});
export const assignByEmailSchema = z.object({ email: email() });

// ---------- Users ----------
export const updateUserRoleSchema = z.object({ role: z.enum(ROLES) });

// ---------- Class groups (POC) ----------
export const createClassGroupSchema = z.object({
  offeringId: z.string().min(1),
  name: trimmed(80),
  academicYear: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, 'Format: 2026-27'),
});
export const assignClassTeacherSchema = assignByEmailSchema;

// ---------- Enrolment ----------
export const joinClassSchema = z.object({
  joinCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,10}$/, 'Invalid join code'),
});
export const directEnrolSchema = z.object({ offeringId: z.string().min(1) });

// ---------- Parent contact & consent (DPDP, safety handoff) ----------
export const PARENT_RELATIONSHIPS = ['mother', 'father', 'guardian', 'other'] as const;
export const parentContactSchema = z.object({
  name: trimmed(120),
  email: email(),
  relationship: z.enum(PARENT_RELATIONSHIPS),
  /** Student acknowledges that a parent is alerted if distress is detected (architecture §6.2). */
  acknowledgeSafetyAlerts: z.literal(true),
});

export type CreateBoard = z.infer<typeof createBoardSchema>;
export type CreateLevel = z.infer<typeof createLevelSchema>;
export type CreateSubject = z.infer<typeof createSubjectSchema>;
export type CreateOffering = z.infer<typeof createOfferingSchema>;
export type CreateInstitution = z.infer<typeof createInstitutionSchema>;
export type UpdateInstitution = z.infer<typeof updateInstitutionSchema>;
export type CreateClassGroup = z.infer<typeof createClassGroupSchema>;
export type ParentContactInput = z.infer<typeof parentContactSchema>;
