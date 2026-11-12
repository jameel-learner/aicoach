/**
 * Outbound notification channel abstraction (decision 9.2-5).
 * Email today; push / WhatsApp / SMS adapters can be added without changing callers.
 */
export type Channel = 'email' | 'push' | 'whatsapp' | 'sms';

export interface OutboundMessage {
  channel: Channel;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Machine tag for logs/tests, e.g. "2fa_otp", "parent_consent". */
  tag: string;
}

export interface Notifier {
  send(message: OutboundMessage): Promise<void>;
  /**
   * False when `send` only writes to a log and nobody receives anything (the console channel
   * outside LOCAL). Callers that tell a person "we have informed X" must check it (safety handoff).
   */
  readonly delivers?: boolean;
}

/** Messages kept in memory for tests and the dev-only /api/dev/outbox endpoint. Capped. */
export const memoryOutbox: OutboundMessage[] = [];
function remember(m: OutboundMessage) {
  memoryOutbox.push(m);
  if (memoryOutbox.length > 200) memoryOutbox.splice(0, memoryOutbox.length - 200);
}

/** Dev: prints messages to the terminal running `wrangler dev` (and keeps them for /api/dev/outbox). */
export class ConsoleNotifier implements Notifier {
  /** On LOCAL the terminal is the inbox (the developer reads it); anywhere else nobody does. */
  constructor(readonly delivers = true) {}
  async send(m: OutboundMessage): Promise<void> {
    remember(m);
    console.log(
      `\n[notify:${m.channel}] (${m.tag}) to=${m.to}\nSubject: ${m.subject}\n${m.text}\n`,
    );
  }
}

/** Tests: keeps messages in memory so tests can read OTPs and links. */
export class MemoryNotifier implements Notifier {
  async send(m: OutboundMessage): Promise<void> {
    remember(m);
  }
}

/** Production email via Resend's HTTP API. */
export class ResendNotifier implements Notifier {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(m: OutboundMessage): Promise<void> {
    if (m.channel !== 'email') throw new Error(`ResendNotifier cannot send channel "${m.channel}"`);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [m.to],
        subject: m.subject,
        text: m.text,
        html: m.html,
        tags: [{ name: 'type', value: m.tag }],
      }),
    });
    if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
  }
}

export function createNotifier(env: {
  EMAIL_PROVIDER: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM: string;
  APP_ENV?: string;
}): Notifier {
  switch (env.EMAIL_PROVIDER) {
    case 'resend':
      // Fail only when an email is actually sent, so a missing key doesn't take down every route.
      if (!env.RESEND_API_KEY) {
        return {
          async send() {
            throw new Error('EMAIL_PROVIDER=resend but RESEND_API_KEY is not set');
          },
        };
      }
      return new ResendNotifier(env.RESEND_API_KEY, env.EMAIL_FROM);
    case 'memory':
      return new MemoryNotifier();
    default:
      return new ConsoleNotifier(env.APP_ENV === 'development');
  }
}
