/**
 * Sending an email, and nothing about which one or why. Brevo is behind it
 * when configured; the tests use the one in memory. Whoever sends records
 * the outcome (see checker.ts), so this only has to succeed or throw.
 */

export type Attachment = { name: string; content: Uint8Array };

export type Email = {
  to: string;
  subject: string;
  /** Plain text: every mail program shows it, and nothing in it can be mistaken for markup. */
  text: string;
  attachments?: readonly Attachment[];
};

export type Mailer = (email: Email) => Promise<{ messageId: string }>;

export class EmailRefused extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "EmailRefused";
  }
}

export type BrevoOptions = {
  apiKey: string;
  from: { name: string; email: string };
  replyTo?: string;
  /** Put in front of every subject; a test installation's mail says so. */
  subjectPrefix?: string;
  fetchImpl?: typeof fetch;
};

export function brevoMailer(options: BrevoOptions): Mailer {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (email) => {
    const response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": options.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: options.from,
        replyTo: options.replyTo ? { email: options.replyTo, name: options.from.name } : undefined,
        to: [{ email: email.to }],
        subject: `${options.subjectPrefix ?? ""}${email.subject}`,
        textContent: email.text,
        attachment: email.attachments?.map((file) => ({
          name: file.name,
          content: Buffer.from(file.content).toString("base64"),
        })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const answer = (await response.json().catch(() => ({}))) as { messageId?: string; code?: string; message?: string };
    if (!response.ok || !answer.messageId) {
      throw new EmailRefused(`Brevo refused the email (HTTP ${response.status}): ${answer.message ?? "no reason given"}`, answer.code);
    }
    return { messageId: answer.messageId };
  };
}

/** Emails Brevo reports as not delivered in the last few days: hard bounces, invalid and blocked addresses. */
export function brevoUndelivered(apiKey: string, fetchImpl: typeof fetch = fetch) {
  return async () => {
    const found: { messageId: string; event: string; reason?: string }[] = [];
    for (const event of ["hardBounces", "invalid", "blocked"]) {
      const url = `https://api.brevo.com/v3/smtp/statistics/events?days=3&limit=500&event=${event}`;
      const response = await fetchImpl(url, {
        headers: { "api-key": apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Brevo events: HTTP ${response.status}`);
      const answer = (await response.json()) as { events?: { messageId?: string; event?: string; reason?: string }[] };
      for (const one of answer.events ?? []) {
        if (one.messageId) found.push({ messageId: one.messageId, event: one.event ?? event, reason: one.reason });
      }
    }
    return found;
  };
}

/** For the tests: keeps what it was given, and can be told to fail. */
export function memoryMailer(): Mailer & { sent: Email[]; failing: boolean } {
  const sent: Email[] = [];
  const mailer = Object.assign(
    async (email: Email) => {
      if (mailer.failing) throw new EmailRefused("the test mailer is failing on purpose");
      sent.push(email);
      return { messageId: `<test-${sent.length}@memory>` };
    },
    { sent, failing: false },
  );
  return mailer;
}
