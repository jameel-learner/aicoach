import type { Role } from './roles';

/** Response shapes shared by the API, web app and mobile app. */

export interface MeUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  twoFactorEnabled: boolean;
}

export interface EnrolmentView {
  id: string;
  roleIn: 'student' | 'teacher';
  offering: { id: string; board: string; level: string; subject: string };
  institution: { id: string; name: string } | null;
  classGroup: { id: string; name: string } | null;
}

export interface ParentContactView {
  name: string;
  email: string;
  relationship: string;
  consentStatus: 'pending' | 'verified' | 'revoked';
}

export interface MeResponse {
  user: MeUser;
  enrolments: EnrolmentView[];
  /** Institutions this user is POC for (role institution_poc). */
  pocInstitutions: { id: string; name: string }[];
  parentContact: ParentContactView | null;
  /** What onboarding steps the client should still show. */
  onboarding: { needsParentContact: boolean; needsEnrolment: boolean };
}

export interface OfferingView {
  id: string;
  board: { id: string; code: string; name: string };
  level: { id: string; code: string; name: string };
  subject: { id: string; code: string; name: string };
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
