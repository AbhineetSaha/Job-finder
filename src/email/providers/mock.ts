/**
 * Mock provider — the default, and the only provider reachable unless
 * EMAIL_MODE=production is set explicitly.
 *
 * Nothing leaves the machine. Sends are recorded in memory so tests and the
 * development UI can assert on exactly what would have been transmitted, and
 * delivery, bounce and reply events can be simulated (brief §60, §62).
 */
import { randomUUID } from 'node:crypto';
import {
  validateSendInput,
  type EmailProvider,
  type ProviderEvent,
  type ProviderMessage,
  type SendEmailInput,
  type SendEmailResult,
  type WebhookRequest,
  type WebhookVerification,
} from '../provider.js';

export interface MockSentMessage {
  providerMessageId: string;
  to: string;
  from: string;
  replyTo?: string | undefined;
  subject: string;
  text: string;
  idempotencyKey: string;
  headers: Record<string, string>;
  sentAt: Date;
}

/** Failures the caller can inject to exercise error handling. */
export interface MockFailureRule {
  matchTo?: string;
  permanent: boolean;
  errorCode: string;
  errorMessage: string;
}

const sent: MockSentMessage[] = [];
const failureRules: MockFailureRule[] = [];
/** Provider-side idempotency, mirroring what a real provider offers. */
const seenIdempotencyKeys = new Map<string, string>();

export const mockProvider: EmailProvider = {
  name: 'mock',

  isConfigured(): boolean {
    return true;
  },

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    const validation = validateSendInput(input);
    if (!validation.ok) {
      return {
        ok: false,
        permanent: true,
        errorCode: 'INVALID_INPUT',
        errorMessage: validation.error,
      };
    }

    const existing = seenIdempotencyKeys.get(input.idempotencyKey);
    if (existing) {
      // A real provider returns the original message rather than sending again.
      return { ok: true, providerMessageId: existing };
    }

    const rule = failureRules.find((r) => !r.matchTo || r.matchTo === input.to);
    if (rule) {
      return {
        ok: false,
        permanent: rule.permanent,
        errorCode: rule.errorCode,
        errorMessage: rule.errorMessage,
      };
    }

    const providerMessageId = `mock-${randomUUID()}`;
    seenIdempotencyKeys.set(input.idempotencyKey, providerMessageId);
    sent.push({
      providerMessageId,
      to: input.to,
      from: input.from,
      replyTo: input.replyTo,
      subject: input.subject,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
      headers: input.headers ?? {},
      sentAt: new Date(),
    });

    return { ok: true, providerMessageId };
  },

  async getMessage(providerMessageId: string): Promise<ProviderMessage | null> {
    const message = sent.find((m) => m.providerMessageId === providerMessageId);
    if (!message) return null;
    return {
      id: message.providerMessageId,
      status: 'sent',
      to: message.to,
      subject: message.subject,
      sentAt: message.sentAt.toISOString(),
    };
  },

  async verifyWebhook(_request: WebhookRequest): Promise<WebhookVerification> {
    // The mock provider does not sign anything. Simulated events are injected
    // through the helpers below rather than through the HTTP webhook route, so
    // this never becomes a way to bypass signature verification in production.
    return { valid: false, reason: 'The mock provider does not accept HTTP webhooks.' };
  },

  parseWebhook(): ProviderEvent[] {
    return [];
  },
};

/* -------------------------------------------------------------------------- */
/* Test and development helpers                                               */
/* -------------------------------------------------------------------------- */

export function getMockSentMessages(): readonly MockSentMessage[] {
  return sent;
}

export function findMockMessageTo(to: string): MockSentMessage | undefined {
  return sent.find((m) => m.to === to);
}

export function resetMockProvider(): void {
  sent.length = 0;
  failureRules.length = 0;
  seenIdempotencyKeys.clear();
}

export function addMockFailure(rule: MockFailureRule): void {
  failureRules.push(rule);
}

/** Build a simulated provider event for the local event pipeline. */
export function simulateEvent(
  type: ProviderEvent['type'],
  options: {
    providerMessageId?: string | null;
    recipient?: string | null;
    permanent?: boolean;
    fromEmail?: string | null;
    subject?: string | null;
    bodyText?: string | null;
  } = {},
): ProviderEvent {
  return {
    eventId: `mock-event-${randomUUID()}`,
    type,
    providerMessageId: options.providerMessageId ?? null,
    recipient: options.recipient ?? null,
    permanent: options.permanent ?? (type === 'bounced'),
    fromEmail: options.fromEmail ?? options.recipient ?? null,
    subject: options.subject ?? null,
    bodyText: options.bodyText ?? null,
    occurredAt: new Date(),
    raw: { simulated: true, type },
  };
}
