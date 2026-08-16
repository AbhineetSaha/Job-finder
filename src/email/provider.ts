/**
 * Email provider abstraction. Nothing outside src/email/ imports a concrete
 * provider; everything resolves through `getEmailProvider()` (brief §22).
 */

export interface SendEmailInput {
  to: string;
  from: string;
  replyTo?: string | undefined;
  subject: string;
  text: string;
  /** Passed to the provider for its own deduplication where supported. */
  idempotencyKey: string;
  headers?: Record<string, string> | undefined;
}

export interface SendEmailSuccess {
  ok: true;
  providerMessageId: string;
}

export interface SendEmailFailure {
  ok: false;
  /** Permanent failures are never retried; transient ones back off. */
  permanent: boolean;
  errorCode: string;
  errorMessage: string;
}

export type SendEmailResult = SendEmailSuccess | SendEmailFailure;

export interface ProviderMessage {
  id: string;
  status: string;
  to?: string;
  subject?: string;
  sentAt?: string;
}

export interface WebhookRequest {
  /** The RAW body. Verification must never run against a re-serialised object. */
  rawBody: string;
  headers: Record<string, string>;
}

export interface WebhookVerification {
  valid: boolean;
  reason?: string;
}

export type ProviderEventType = 'delivered' | 'bounced' | 'complained' | 'replied' | 'unknown';

export interface ProviderEvent {
  /** Stable id from the provider; the uniqueness key that defeats replay. */
  eventId: string;
  type: ProviderEventType;
  providerMessageId: string | null;
  recipient: string | null;
  /** For bounces: whether the address is permanently undeliverable. */
  permanent?: boolean;
  /** For replies. */
  fromEmail?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  occurredAt: Date;
  raw: Record<string, unknown>;
}

export interface EmailProvider {
  readonly name: string;
  /** False until every credential this provider needs is present. */
  isConfigured(): boolean;
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
  getMessage?(providerMessageId: string): Promise<ProviderMessage | null>;
  verifyWebhook?(request: WebhookRequest): Promise<WebhookVerification>;
  parseWebhook?(request: WebhookRequest): ProviderEvent[];
}

/** Validation applied to every send regardless of provider. */
export function validateSendInput(input: SendEmailInput): { ok: true } | { ok: false; error: string } {
  if (!input.to || !input.from) return { ok: false, error: 'Both "to" and "from" are required.' };
  // CR/LF in any header field is an injection attempt. Rejected here as a last
  // line of defence, in addition to the checks at the domain and preflight layers.
  for (const [field, value] of Object.entries({
    to: input.to,
    from: input.from,
    replyTo: input.replyTo ?? '',
    subject: input.subject,
  })) {
    if (/[\r\n]/.test(value)) {
      return { ok: false, error: `Header field "${field}" contains a line break.` };
    }
  }
  if (!input.subject.trim()) return { ok: false, error: 'Subject must not be empty.' };
  if (!input.text.trim()) return { ok: false, error: 'Body must not be empty.' };
  return { ok: true };
}
