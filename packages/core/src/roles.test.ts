import { describe, expect, it } from 'vitest';
import {
  generateJoinCode,
  isRole,
  isSelfSignupRole,
  joinClassSchema,
  parentContactSchema,
} from './index';

describe('roles', () => {
  it('only students and teachers can self-sign-up', () => {
    expect(isSelfSignupRole('student')).toBe(true);
    expect(isSelfSignupRole('teacher')).toBe(true);
    expect(isSelfSignupRole('admin')).toBe(false);
    expect(isSelfSignupRole('institution_poc')).toBe(false);
    expect(isRole('institution_poc')).toBe(true);
    expect(isRole('superuser')).toBe(false);
  });
});

describe('join codes', () => {
  it('generates codes accepted by the join schema', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateJoinCode();
      expect(code).toMatch(/^[A-Z2-9]{8}$/);
      expect(code).not.toMatch(/[01OIL]/);
      expect(joinClassSchema.parse({ joinCode: code.toLowerCase() }).joinCode).toBe(code);
    }
  });
});

describe('parent contact', () => {
  it('requires the safety-alert acknowledgement', () => {
    const base = { name: 'A Parent', email: 'P@Example.com ', relationship: 'mother' };
    expect(parentContactSchema.safeParse(base).success).toBe(false);
    const ok = parentContactSchema.parse({ ...base, acknowledgeSafetyAlerts: true });
    expect(ok.email).toBe('p@example.com');
  });
});
