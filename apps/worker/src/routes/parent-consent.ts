import { consents, parentContacts, user } from '@aicoach/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { audit } from '../lib/audit';
import { escapeHtml, sha256Hex } from '../lib/tokens';
import { CONSENT_VERSION } from './me';

/**
 * Public parent-consent page (no login). GET shows what is being agreed to; POST records it.
 * Using POST to confirm stops email link scanners from "consenting" by prefetching the link.
 */
export const parentConsentRoutes = new Hono<AppBindings>();

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#F7F8FA;--card:#fff;--text:#14181F;--muted:#55606E;--primary:#1F5FBF;--on-primary:#fff;--border:#D8DEE6}
@media (prefers-color-scheme:dark){:root{--bg:#0E1116;--card:#161B22;--text:#E8ECF2;--muted:#9AA6B5;--primary:#6EA2F5;--on-primary:#0B1220;--border:#2E3744}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px}
h1{font-size:22px;margin:0 0 12px}p,li{color:var(--muted)}
button{min-height:48px;padding:0 20px;border:0;border-radius:10px;background:var(--primary);color:var(--on-primary);font-size:16px;font-weight:600;cursor:pointer}
</style></head><body><main><div class="card">${body}</div></main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function findByToken(db: AppBindings['Variables']['db'], token: string | undefined) {
  if (!token || token.length < 20 || token.length > 100) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .select({ contact: parentContacts, studentName: user.name })
    .from(parentContacts)
    .innerJoin(user, eq(user.id, parentContacts.studentId))
    .where(eq(parentContacts.consentTokenHash, hash))
    .get();
  return row ?? null;
}

const invalid = () =>
  page(
    'Link not valid',
    '<h1>This link is not valid</h1><p>It may have expired or been replaced by a newer email. Ask your child to send the request again from the AI Coach app.</p>',
    400,
  );

parentConsentRoutes.get('/', async (c) => {
  const token = c.req.query('token');
  const found = await findByToken(c.var.db, token);
  if (!found) return invalid();
  const { contact, studentName } = found;
  if (contact.consentStatus === 'verified') {
    return page(
      'Already confirmed',
      `<h1>Thank you, you have already confirmed</h1><p>Consent for ${escapeHtml(studentName)} is recorded.</p>`,
    );
  }
  return page(
    'Parent consent',
    `<h1>Consent for ${escapeHtml(studentName)}</h1>
<p>Dear ${escapeHtml(contact.name)}, by confirming you agree that:</p>
<ol>
<li>AI Coach may process ${escapeHtml(studentName)}'s study data (answers, progress and practice history) to provide the study service.</li>
<li>AI Coach may email you at ${escapeHtml(contact.email)} if it detects that ${escapeHtml(studentName)} may be in distress while studying.</li>
</ol>
<p>You can withdraw consent at any time by contacting the institution or AI Coach support.</p>
<form method="post"><input type="hidden" name="token" value="${escapeHtml(token!)}"><button type="submit">I confirm</button></form>`,
  );
});

parentConsentRoutes.post('/', async (c) => {
  const form = await c.req.formData().catch(() => null);
  const token = form?.get('token');
  const found = await findByToken(c.var.db, typeof token === 'string' ? token : undefined);
  if (!found) return invalid();
  const { contact, studentName } = found;
  if (contact.consentStatus !== 'verified') {
    const now = new Date();
    await c.var.db.batch([
      c.var.db
        .update(parentContacts)
        .set({ consentStatus: 'verified', consentVerifiedAt: now })
        .where(eq(parentContacts.id, contact.id)),
      c.var.db.insert(consents).values([
        {
          userId: contact.studentId,
          type: 'parent_data_processing',
          version: CONSENT_VERSION,
          grantedBy: 'parent',
          grantedAt: now,
        },
        {
          userId: contact.studentId,
          type: 'safety_parent_alerts',
          version: CONSENT_VERSION,
          grantedBy: 'parent',
          grantedAt: now,
        },
      ]),
    ]);
    await audit(c.var.db, null, 'parent_consent_verified', 'parent_contact', contact.id);
  }
  return page(
    'Consent confirmed',
    `<h1>Thank you</h1><p>Your consent for ${escapeHtml(studentName)} has been recorded.</p>`,
  );
});
