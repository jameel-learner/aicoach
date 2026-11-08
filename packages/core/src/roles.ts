/** Platform roles (architecture §2.1, decision 6). One primary role per user. */
export const ROLES = ['admin', 'institution_poc', 'teacher', 'student'] as const;
export type Role = (typeof ROLES)[number];

/** Roles a user may pick for themselves at sign-up. Admin and POC are assigned by an Admin. */
export const SELF_SIGNUP_ROLES = ['student', 'teacher'] as const satisfies readonly Role[];
export type SelfSignupRole = (typeof SELF_SIGNUP_ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isSelfSignupRole(value: unknown): value is SelfSignupRole {
  return typeof value === 'string' && (SELF_SIGNUP_ROLES as readonly string[]).includes(value);
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  institution_poc: 'Institution POC',
  teacher: 'Teacher',
  student: 'Student',
};
