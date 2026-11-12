import {
  enrolments,
  institutionPocs,
  parentContacts,
  safetyEvents,
  user as users,
  type Db,
} from '@aicoach/db';
import { HANDOFF, type Notified } from '@aicoach/journeys';
import { and, desc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import type { SessionUser } from '../env';
import { audit } from '../lib/audit';
import type { Notifier, OutboundMessage } from '../lib/notifier';
import { escapeHtml } from '../lib/tokens';
import type { Classification } from './classify';

/**
 * Distress handoff (architecture §6.2, decisions 9.1-4 and 9.6-5). The learner gets the fixed
 * response (packages/journeys/src/copy.ts); this module tells an adult and logs the trigger.
 *
 *  - Who is told: the parent, if their consent is verified; otherwise the POCs of the learner's
 *    institution(s); otherwise nobody (the event still shows for Admin).
 *  - When someone is hurting the learner (rule `harm_by_others`) the parent is NOT emailed: the
 *    alert goes to the institution, because the person at home may be the problem.
 *  - At most one alert email per learner in 12 hours; every trigger is logged.
 *  - The learner's words are never stored or sent.
 */

const QUIET_MS = 12 * 3600_000;

const signoff = `If you are worried about their safety right now, call Tele-MANAS on 14416 (free, any time, Government of India) or 112.

— AI Coach`;

export function parentAlertEmail(o: {
  to: string;
  parentName: string;
  studentName: string;
}): OutboundMessage {
  const text = `Dear ${o.parentName},

${o.studentName} was studying on AI Coach today and wrote something that suggests they may be feeling very low or under heavy pressure.

We can't tell how serious it is, and an app shouldn't try to. We stopped the study session and showed ${o.studentName} a short message asking them to talk to someone they trust, with the Tele-MANAS helpline number (14416). We have not shared what they wrote, and we told them that you would be informed.

What usually helps most is a calm, unhurried conversation today: ask how they are doing, and mostly listen. Marks can wait for that.

${signoff}

You are receiving this because ${o.studentName} named you as their parent or guardian and you agreed to be contacted in a situation like this.`;
  return {
    channel: 'email',
    tag: 'safety_parent_alert',
    to: o.to,
    subject: `${o.studentName} may need your support today`,
    text,
    html: text
      .split('\n\n')
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
      .join('\n'),
  };
}

export function pocAlertEmail(o: {
  to: string;
  pocName: string;
  studentName: string;
  /** No verified parent contact, or the parent was deliberately not told. */
  reason: 'no_parent' | 'not_parent';
}): OutboundMessage {
  const why =
    o.reason === 'not_parent'
      ? 'Because of what was written, we have NOT contacted the parent or guardian. Please have a counsellor or a trusted teacher speak with the student privately first.'
      : 'We have no confirmed parent or guardian contact for this student, so we are telling you instead. Please have a counsellor or a trusted teacher check in with them today, and consider informing the family.';
  return {
    channel: 'email',
    tag: 'safety_poc_alert',
    to: o.to,
    subject: `A student may need support today: ${o.studentName}`,
    text: `Dear ${o.pocName},

${o.studentName}, a student of your institution, was studying on AI Coach today and wrote something that suggests they may be in distress.

We stopped the study session and showed the student a short message asking them to talk to someone they trust, with the Tele-MANAS helpline number (14416). We have not shared what they wrote.

${why}

${signoff}`,
  };
}

export interface HandoffResult {
  /** What the learner is told (the fixed response says so honestly). */
  told: Notified;
  eventId: string;
}

export async function handoff(
  db: Db,
  notifier: Notifier,
  me: SessionUser,
  trigger: Pick<Classification, 'rule' | 'detector'> & {
    source: 'session' | 'ask' | 'artefact';
    sessionId?: string;
  },
): Promise<HandoffResult> {
  const recent = await db
    .select({ notified: safetyEvents.notified })
    .from(safetyEvents)
    .where(
      and(
        eq(safetyEvents.userId, me.id),
        inArray(safetyEvents.notified, ['parent', 'poc']),
        gt(safetyEvents.createdAt, new Date(Date.now() - QUIET_MS)),
      ),
    )
    .orderBy(desc(safetyEvents.createdAt))
    .get();

  let told: Notified = 'none';
  let notified: 'parent' | 'poc' | 'none' | 'suppressed' = 'none';
  const send = async (m: OutboundMessage) => {
    try {
      await notifier.send(m);
      // A channel that only logs (staging without real email) has told nobody: the learner must
      // not be told otherwise, and Admin sees "Nobody to tell" and follows up.
      return notifier.delivers !== false;
    } catch (err) {
      console.error(`safety alert (${m.tag}) could not be sent`, err);
      return false;
    }
  };

  if (recent) {
    // Someone was told in the last 12 hours: say so, don't email again.
    told = recent.notified === 'parent' ? 'parent' : 'poc';
    notified = 'suppressed';
  } else {
    const parent =
      me.role === 'student' && trigger.rule !== 'harm_by_others'
        ? await db
            .select()
            .from(parentContacts)
            .where(
              and(
                eq(parentContacts.studentId, me.id),
                eq(parentContacts.consentStatus, 'verified'),
              ),
            )
            .get()
        : null;
    if (
      parent &&
      (await send(
        parentAlertEmail({ to: parent.email, parentName: parent.name, studentName: me.name }),
      ))
    ) {
      told = notified = 'parent';
    } else if (me.role === 'student') {
      const pocs = await db
        .selectDistinct({ email: users.email, name: users.name })
        .from(enrolments)
        .innerJoin(institutionPocs, eq(institutionPocs.institutionId, enrolments.institutionId))
        .innerJoin(users, eq(users.id, institutionPocs.userId))
        .where(
          and(
            eq(enrolments.userId, me.id),
            eq(enrolments.status, 'active'),
            isNotNull(enrolments.institutionId),
          ),
        )
        .limit(5);
      let sent = 0;
      for (const p of pocs)
        if (
          await send(
            pocAlertEmail({
              to: p.email,
              pocName: p.name,
              studentName: me.name,
              reason: trigger.rule === 'harm_by_others' ? 'not_parent' : 'no_parent',
            }),
          )
        )
          sent++;
      if (sent) told = notified = 'poc';
    }
  }

  const row = await db
    .insert(safetyEvents)
    .values({
      userId: me.id,
      source: trigger.source,
      sessionId: trigger.sessionId ?? null,
      detector: trigger.detector,
      rule: trigger.rule,
      notified,
    })
    .returning({ id: safetyEvents.id })
    .get();
  await audit(db, me.id, 'safety_handoff', 'safety_event', row.id, {
    source: trigger.source,
    rule: trigger.rule,
    notified,
  });
  return { told, eventId: row.id };
}

/** The fixed response for surfaces without a journey view (Ask). */
export function handoffMessage(told: Notified) {
  return {
    title: HANDOFF.title,
    text: HANDOFF.text,
    helplines: [...HANDOFF.helplines],
    told: HANDOFF.told[told],
  };
}
