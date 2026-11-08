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

export function creditsReceivedEmail(opts: {
  to: string;
  name: string;
  /** Formatted rupee amount, e.g. "₹8,350.00". */
  amount: string;
  walletLabel: string;
  edited?: boolean;
  appUrl: string;
}): OutboundMessage {
  const { to, name, amount, walletLabel, edited, appUrl } = opts;
  const what = edited
    ? `An allotment to ${walletLabel} was corrected to ${amount}.`
    : `${amount} of AI Coach credits were added to ${walletLabel}.`;
  return {
    channel: 'email',
    tag: edited ? 'credits_edited' : 'credits_received',
    to,
    subject: edited ? `Credits corrected: ${amount}` : `You received ${amount} of AI Coach credits`,
    text: `Hi ${name},\n\n${what}\n\nPlease open AI Coach and confirm the amount is correct (Credits → Confirm received). Once you confirm, the sender can lock it.\n\n${appUrl}\n\n— AI Coach`,
  };
}

export function creditRequestEmail(opts: {
  to: string;
  name: string;
  requester: string;
  walletLabel: string;
  amount: string;
  message?: string;
  /** Requests to Admin: the payment to verify. */
  payment?: { reference: string; method: string; paidOn: string };
  appUrl: string;
}): OutboundMessage {
  const { to, name, requester, walletLabel, amount, message, payment, appUrl } = opts;
  const pay = payment
    ? `\n\nPayment to verify: ${amount} by ${payment.method.replace('_', ' ')} on ${payment.paidOn}, UTR/reference ${payment.reference}.`
    : '';
  const where = payment
    ? 'Check the payment against your bank statement, then confirm or reject it under Credits & payments → Payments to verify.'
    : 'You can accept or reject it on the Credits page in AI Coach.';
  return {
    channel: 'email',
    tag: 'credit_request',
    to,
    subject: `${requester} is asking for ${amount} of AI Coach credits`,
    text: `Hi ${name},\n\n${requester} (${walletLabel}) has asked for ${amount} of credits.${message ? `\n\nMessage: "${message}"` : ''}${pay}\n\n${where}\n\n${appUrl}\n\n— AI Coach`,
  };
}

export function creditRequestDecisionEmail(opts: {
  to: string;
  name: string;
  approved: boolean;
  requested: string;
  granted?: string;
  walletLabel: string;
  note?: string | null;
  appUrl: string;
}): OutboundMessage {
  const { to, name, approved, requested, granted, walletLabel, note, appUrl } = opts;
  const what = approved
    ? `Your request for ${requested} (${walletLabel}) was accepted. ${granted} was added.`
    : `Your request for ${requested} (${walletLabel}) was not accepted.`;
  return {
    channel: 'email',
    tag: approved ? 'credit_request_approved' : 'credit_request_rejected',
    to,
    subject: approved ? `Credits added: ${granted}` : 'Your credit request was not accepted',
    text: `Hi ${name},\n\n${what}${note ? `\n\nComment: "${note}"` : ''}\n\n${appUrl}\n\n— AI Coach`,
  };
}
