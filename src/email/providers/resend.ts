/**
 * Resend adapter, written against the HTTP API with `fetch` so it adds no
 * dependency. Reachable only when EMAIL_MODE=production.
 *
 * The shape of this file is the point: a second real provider is a sibling
 * module implementing the same interface, with no change anywhere else.
 */
import { getEnv } from '../../lib/env.js';
import { safeEqual } from '../../lib/crypto.js';
import { createHmac } from 'node:crypto';
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

const API_BASE = 'https://api.resend.com';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Status codes that will never succeed on retry. Everything else — including
 * 429 and 5xx — is transient and backs off.
 */
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 422]);

export const resendProvider: EmailProvider = {
  name: 'resend',

  isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM);
  },

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    const validation = validateSendInput(input);
    if (!validation.ok) {
      return { ok: false, permanent: true, errorCode: 'INVALID_INPUT', errorMessage: validation.error };
    }

    const env = getEnv();
    if (!env.EMAIL_API_KEY) {
      return {
        ok: false,
        permanent: true,
        errorCode: 'NOT_CONFIGURED',
        errorMessage: 'EMAIL_API_KEY is not set.',
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${API_BASE}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.EMAIL_API_KEY}`,
          'content-type': 'application/json',
          // Provider-side idempotency, in addition to our own attempt ledger.
          'idempotency-key': input.idempotencyKey,
        },
        body: JSON.stringify({
          from: input.from,
          to: [input.to],
          ...(input.replyTo ? { reply_to: input.replyTo } : {}),
          subject: input.subject,
          text: input.text,
          ...(input.headers ? { headers: input.headers } : {}),
        }),
        signal: controller.signal,
      });

      const bodyText = await response.text();

      if (!response.ok) {
        return {
          ok: false,
          permanent: PERMANENT_STATUS.has(response.status),
          errorCode: `HTTP_${response.status}`,
          errorMessage: bodyText.slice(0, 500),
        };
      }

      let parsed: { id?: string };
      try {
        parsed = JSON.parse(bodyText) as { id?: string };
      } catch {
        return {
          ok: false,
          permanent: false,
          errorCode: 'MALFORMED_RESPONSE',
          errorMessage: 'Provider returned a non-JSON success response.',
        };
      }

      if (!parsed.id) {
        return {
          ok: false,
          permanent: false,
          errorCode: 'MISSING_MESSAGE_ID',
          errorMessage: 'Provider accepted the message but returned no id.',
        };
      }

      return { ok: true, providerMessageId: parsed.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A network failure or timeout is ambiguous: the provider may have
      // accepted the message. Treated as transient, and the attempt row plus
      // the idempotency key stop a retry from producing a second delivery.
      return { ok: false, permanent: false, errorCode: 'NETWORK_ERROR', errorMessage: message };
    } finally {
      clearTimeout(timeout);
    }
  },

  async getMessage(providerMessageId: string): Promise<ProviderMessage | null> {
    const env = getEnv();
    if (!env.EMAIL_API_KEY) return null;

    const response = await fetch(`${API_BASE}/emails/${encodeURIComponent(providerMessageId)}`, {
      headers: { authorization: `Bearer ${env.EMAIL_API_KEY}` },
    });
    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, unknown>;
    return {
      id: String(data.id ?? providerMessageId),
      status: String(data.last_event ?? 'unknown'),
      to: Array.isArray(data.to) ? String(data.to[0]) : undefined,
      subject: typeof data.subject === 'string' ? data.subject : undefined,
    };
  },

  /**
   * Signature verification over the RAW body.
   *
   * Rejects when the secret is unset, the signature is absent or malformed,
   * the timestamp is outside the tolerance window, or the digest differs.
   */
  async verifyWebhook(request: WebhookRequest): Promise<WebhookVerification> {
    const env = getEnv();
    const secret = env.EMAIL_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'EMAIL_WEBHOOK_SECRET is not configured.' };

    const timestamp = request.headers['svix-timestamp'] ?? request.headers['webhook-timestamp'];
    const signatureHeader = request.headers['svix-signature'] ?? request.headers['webhook-signature'];
    const messageId = request.headers['svix-id'] ?? request.headers['webhook-id'];

    if (!timestamp || !signatureHeader || !messageId) {
      return { valid: false, reason: 'Missing signature headers.' };
    }

    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds)) {
      return { valid: false, reason: 'Malformed timestamp header.' };
    }
    const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
    if (ageSeconds > env.WEBHOOK_TOLERANCE_SECONDS) {
      return { valid: false, reason: `Timestamp is ${Math.round(ageSeconds)}s old; outside tolerance.` };
    }

    const signedPayload = `${messageId}.${timestamp}.${request.rawBody}`;
    const secretBytes = secret.startsWith('whsec_')
      ? Buffer.from(secret.slice(6), 'base64')
      : Buffer.from(secret, 'utf8');
    const expected = createHmac('sha256', secretBytes).update(signedPayload).digest('base64');

    // The header may carry several space-separated "v1,<sig>" candidates.
    const candidates = signatureHeader
      .split(' ')
      .map((part) => (part.includes(',') ? part.slice(part.indexOf(',') + 1) : part));

    const matched = candidates.some((candidate) => safeEqual(candidate, expected));
    return matched ? { valid: true } : { valid: false, reason: 'Signature mismatch.' };
  },

  parseWebhook(request: WebhookRequest): ProviderEvent[] {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(request.rawBody) as Record<string, unknown>;
    } catch {
      return [];
    }

    const type = String(payload.type ?? '');
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const eventId =
      request.headers['svix-id'] ??
      request.headers['webhook-id'] ??
      String(data.email_id ?? '') + type;

    const recipient = Array.isArray(data.to) ? String(data.to[0]) : null;
    const occurredAt = payload.created_at ? new Date(String(payload.created_at)) : new Date();

    const mapped: ProviderEvent['type'] =
      type === 'email.delivered'
        ? 'delivered'
        : type === 'email.bounced'
          ? 'bounced'
          : type === 'email.complained'
            ? 'complained'
            : 'unknown';

    if (mapped === 'unknown') return [];

    const bounceType = String((data.bounce as Record<string, unknown> | undefined)?.type ?? '');

    return [
      {
        eventId: eventId || `${type}-${Date.now()}`,
        type: mapped,
        providerMessageId: data.email_id ? String(data.email_id) : null,
        recipient,
        // Only a hard bounce suppresses permanently; a soft bounce may recover.
        permanent: mapped === 'bounced' ? bounceType.toLowerCase() !== 'soft' : false,
        occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
        raw: payload,
      },
    ];
  },
};
