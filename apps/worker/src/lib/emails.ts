import type { OutboundMessage } from './notifier';
import { escapeHtml } from './tokens';

/** Plain, honest copy. No urgency tricks (engagement policy, architecture §6.1). */

export function otpEmail(to: string, name: string, otp: string): OutboundMessage {
  return {
    channel: 'email',
    tag: '2fa_otp',
    to,
    subject: `Your AI Coach sign-in code: ${otp}`,
    text: `Hi ${name},\n\nYour sign-in code is ${otp}. It expires in 10 minutes.\n\nIf you didn't try to sign in, you can ignore this email. Your account stays safe because nobody can sign in without this code.\n\n— AI Coach`,
    html: `<p>Hi ${escapeHtml(name)},</p><p>Your sign-in code is <strong style="font-size:20px;letter-spacing:3px">${otp}</strong>. It expires in 10 minutes.</p><p>If you didn't try to sign in, you can ignore this email.</p><p>— AI Coach</p>`,
  };
}

export function parentConsentEmail(opts: {
  to: string;
  parentName: string;
  studentName: string;
  link: string;
}): OutboundMessage {
  const { to, parentName, studentName, link } = opts;
  const text = `Dear ${parentName},

${studentName} has signed up for AI Coach, a study app for board-exam preparation, and listed you as their parent or guardian.

Please confirm two things by opening this link:
  1. You consent to AI Coach processing ${studentName}'s study data to provide the service.
  2. You agree to be contacted by email if AI Coach detects that ${studentName} may be in distress while studying.

${link}

If you don't know about this, you can ignore this email and no consent will be recorded.

— AI Coach`;
  return {
    channel: 'email',
    tag: 'parent_consent',
    to,
    subject: `Please confirm consent for ${studentName} on AI Coach`,
    text,
    html: `<p>Dear ${escapeHtml(parentName)},</p>
<p>${escapeHtml(studentName)} has signed up for AI Coach, a study app for board-exam preparation, and listed you as their parent or guardian.</p>
<p>Please confirm that:</p>
<ol><li>You consent to AI Coach processing ${escapeHtml(studentName)}'s study data to provide the service.</li>
<li>You agree to be contacted by email if AI Coach detects that ${escapeHtml(studentName)} may be in distress while studying.</li></ol>
<p><a href="${escapeHtml(link)}">Review and confirm consent</a></p>
<p>If you don't know about this, you can ignore this email and no consent will be recorded.</p><p>— AI Coach</p>`,
  };
}
