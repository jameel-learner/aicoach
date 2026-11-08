import { describe, expect, it } from 'vitest';
import { call, createSignedInUser, json, seedPilotTaxonomy } from './helpers';
import { memoryOutbox } from '../src/lib/notifier';

/** Builds: admin → institution (with POC) → class (with class teacher) → enrolled student. */
async function buildInstitutionTree() {
  const offeringId = await seedPilotTaxonomy();
  const admin = await createSignedInUser('admin');
  const poc = await createSignedInUser('institution_poc');
  const teacher = await createSignedInUser('teacher');
  const student = await createSignedInUser('student');

  const inst = await json(
    await call('POST', '/api/admin/institutions', {
      jar: admin.jar,
      body: { name: 'Vidya PU College', type: 'college', city: 'Mysuru' },
    }),
  );
  expect(
    (
      await call('POST', `/api/admin/institutions/${inst.id}/pocs`, {
        jar: admin.jar,
        body: { email: poc.email },
      })
    ).status,
  ).toBe(201);

  const clsRes = await call('POST', `/api/institutions/${inst.id}/classes`, {
    jar: poc.jar,
    body: { offeringId, name: '2nd PUC Commerce A', academicYear: '2026-27' },
  });
  expect(clsRes.status).toBe(201);
  const cls = await json(clsRes);
  expect(cls.joinCode).toMatch(/^[A-Z2-9]{8}$/);

  expect(
    (
      await call('PUT', `/api/institutions/${inst.id}/classes/${cls.id}/teacher`, {
        jar: poc.jar,
        body: { email: teacher.email },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('POST', '/api/me/enrolments/join', {
        jar: student.jar,
        body: { joinCode: cls.joinCode.toLowerCase() },
      })
    ).status,
  ).toBe(201);

  return { offeringId, admin, poc, teacher, student, inst, cls };
}

describe('role-based access', () => {
  it('unauthenticated requests get 401', async () => {
    expect((await call('GET', '/api/me')).status).toBe(401);
    expect((await call('GET', '/api/admin/boards')).status).toBe(401);
  });

  it('only admins reach admin APIs', async () => {
    for (const role of ['student', 'teacher', 'institution_poc'] as const) {
      const { jar } = await createSignedInUser(role);
      expect((await call('GET', '/api/admin/boards', { jar })).status).toBe(403);
      expect(
        (
          await call('POST', '/api/admin/institutions', {
            jar,
            body: { name: 'X', type: 'school' },
          })
        ).status,
      ).toBe(403);
    }
    const { jar } = await createSignedInUser('admin');
    expect((await call('GET', '/api/admin/boards', { jar })).status).toBe(200);
  });

  it('admins cannot change their own role; can change others', async () => {
    const admin = await createSignedInUser('admin');
    const other = await createSignedInUser('teacher');
    const me = await json(await call('GET', '/api/me', { jar: admin.jar }));
    expect(
      (
        await call('PATCH', `/api/admin/users/${me.user.id}/role`, {
          jar: admin.jar,
          body: { role: 'student' },
        })
      ).status,
    ).toBe(400);
    const otherMe = await json(await call('GET', '/api/me', { jar: other.jar }));
    expect(
      (
        await call('PATCH', `/api/admin/users/${otherMe.user.id}/role`, {
          jar: admin.jar,
          body: { role: 'student' },
        })
      ).status,
    ).toBe(200);
  });

  it('students cannot be made POCs', async () => {
    const admin = await createSignedInUser('admin');
    const student = await createSignedInUser('student');
    const inst = await json(
      await call('POST', '/api/admin/institutions', {
        jar: admin.jar,
        body: { name: 'S', type: 'school' },
      }),
    );
    expect(
      (
        await call('POST', `/api/admin/institutions/${inst.id}/pocs`, {
          jar: admin.jar,
          body: { email: student.email },
        })
      ).status,
    ).toBe(400);
  });
});

describe('institution tree & tenant isolation', () => {
  it('builds admin → institution → class → student, visible to the right people only', async () => {
    const { admin, poc, teacher, student, inst, cls } = await buildInstitutionTree();

    // POC sees own classes with the teacher and student count
    const classes = await json(
      await call('GET', `/api/institutions/${inst.id}/classes`, { jar: poc.jar }),
    );
    expect(classes).toHaveLength(1);
    expect(classes[0].classTeacher.email).toBe(teacher.email);
    expect(classes[0].studentCount).toBe(1);

    // POC /me lists the institution
    const pocMe = await json(await call('GET', '/api/me', { jar: poc.jar }));
    expect(pocMe.pocInstitutions.map((i: { id: string }) => i.id)).toEqual([inst.id]);

    // Teacher sees the class and its student
    const tClasses = await json(await call('GET', '/api/teacher/classes', { jar: teacher.jar }));
    expect(tClasses).toHaveLength(1);
    expect(tClasses[0].isClassTeacher).toBe(true);
    const students = await json(
      await call('GET', `/api/teacher/classes/${cls.id}/students`, { jar: teacher.jar }),
    );
    expect(students.map((s: { email: string }) => s.email)).toEqual([student.email]);

    // Student sees own enrolment; cannot list classmates
    const sMe = await json(await call('GET', '/api/me', { jar: student.jar }));
    expect(sMe.enrolments).toHaveLength(1);
    expect(sMe.enrolments[0]).toMatchObject({
      roleIn: 'student',
      classGroup: { id: cls.id },
      institution: { id: inst.id },
    });
    expect(
      (await call('GET', `/api/teacher/classes/${cls.id}/students`, { jar: student.jar })).status,
    ).toBe(403);

    // Admin sees everything
    expect(
      (await call('GET', `/api/institutions/${inst.id}/classes`, { jar: admin.jar })).status,
    ).toBe(200);
    expect(
      (await call('GET', `/api/teacher/classes/${cls.id}/students`, { jar: admin.jar })).status,
    ).toBe(200);
  });

  it("a POC cannot see or change another institution's classes", async () => {
    const a = await buildInstitutionTree();
    const b = await buildInstitutionTree();
    expect(
      (await call('GET', `/api/institutions/${b.inst.id}/classes`, { jar: a.poc.jar })).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/institutions/${b.inst.id}/classes`, {
          jar: a.poc.jar,
          body: { offeringId: a.offeringId, name: 'Sneaky', academicYear: '2026-27' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('GET', `/api/teacher/classes/${b.cls.id}/students`, { jar: a.poc.jar })).status,
    ).toBe(403);
  });

  it("a teacher cannot see another class's students", async () => {
    const a = await buildInstitutionTree();
    const b = await buildInstitutionTree();
    expect(
      (await call('GET', `/api/teacher/classes/${b.cls.id}/students`, { jar: a.teacher.jar }))
        .status,
    ).toBe(403);
  });

  it('duplicate joins are rejected and bad codes 404', async () => {
    const { student, cls } = await buildInstitutionTree();
    expect(
      (
        await call('POST', '/api/me/enrolments/join', {
          jar: student.jar,
          body: { joinCode: cls.joinCode },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('POST', '/api/me/enrolments/join', {
          jar: student.jar,
          body: { joinCode: 'ZZZZZZZZ' },
        })
      ).status,
    ).toBe(404);
  });

  it('direct enrolment works once per offering', async () => {
    const offeringId = await seedPilotTaxonomy();
    const { jar } = await createSignedInUser('student');
    expect(
      (await call('POST', '/api/me/enrolments/direct', { jar, body: { offeringId } })).status,
    ).toBe(201);
    expect(
      (await call('POST', '/api/me/enrolments/direct', { jar, body: { offeringId } })).status,
    ).toBe(409);
    const me = await json(await call('GET', '/api/me', { jar }));
    expect(me.enrolments[0]).toMatchObject({ institution: null, classGroup: null });
    expect(me.onboarding.needsEnrolment).toBe(false);
  });
});

describe('parent contact & consent', () => {
  it('student registers a parent, parent confirms via the emailed link', async () => {
    const { jar } = await createSignedInUser('student', 'Asha');
    let me = await json(await call('GET', '/api/me', { jar }));
    expect(me.onboarding.needsParentContact).toBe(true);

    const parentEmail = `parent.${Date.now()}@example.com`;
    const missingAck = await call('PUT', '/api/me/parent-contact', {
      jar,
      body: { name: 'Lakshmi', email: parentEmail, relationship: 'mother' },
    });
    expect(missingAck.status).toBe(400);

    const ok = await call('PUT', '/api/me/parent-contact', {
      jar,
      body: {
        name: 'Lakshmi',
        email: parentEmail,
        relationship: 'mother',
        acknowledgeSafetyAlerts: true,
      },
    });
    expect(ok.status).toBe(200);

    const mail = memoryOutbox.find((m) => m.to === parentEmail && m.tag === 'parent_consent');
    expect(mail).toBeDefined();
    const link = mail!.text.match(/https?:\/\/\S+/)![0];
    const token = new URL(link).searchParams.get('token')!;

    // GET shows the page but does not consent (link scanners)
    const page = await call('GET', `/api/parent-consent?token=${encodeURIComponent(token)}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Asha');
    me = await json(await call('GET', '/api/me', { jar }));
    expect(me.parentContact.consentStatus).toBe('pending');

    // POST confirms
    expect((await call('POST', '/api/parent-consent', { form: { token } })).status).toBe(200);
    me = await json(await call('GET', '/api/me', { jar }));
    expect(me.parentContact.consentStatus).toBe('verified');
    expect(me.onboarding.needsParentContact).toBe(false);

    // Bad token
    expect(
      (await call('GET', '/api/parent-consent?token=not-a-real-token-at-all-xyz')).status,
    ).toBe(400);
  });

  it('teachers do not need a parent contact', async () => {
    const { jar } = await createSignedInUser('teacher');
    const me = await json(await call('GET', '/api/me', { jar }));
    expect(me.onboarding.needsParentContact).toBe(false);
    expect((await call('PUT', '/api/me/parent-contact', { jar, body: {} })).status).toBe(403);
  });
});
