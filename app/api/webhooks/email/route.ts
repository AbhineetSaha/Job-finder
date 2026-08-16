/**
 * Inbound provider webhook.
 *
 * CSRF-exempt by design — no cookie participates — and authenticated instead
 * by HMAC over the RAW body, with a freshness window and a replay table.
 * An unverified request never reaches the event handlers.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getEmailProvider } from '../../../../src/email/index.js';
import { processProviderEvent } from '../../../../src/services/events.js';
import { recordAudit } from '../../../../src/services/audit.js';
import { logger } from '../../../../src/lib/logger.js';
import { getEnv } from '../../../../src/lib/env.js';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!getEnv().EMAIL_WEBHOOK_SECRET) {
    // Without a shared secret nothing can be authenticated, so nothing is accepted.
    return NextResponse.json({ error: 'Webhooks are not configured.' }, { status: 503 });
  }

  const provider = getEmailProvider();
  if (!provider.verifyWebhook || !provider.parseWebhook) {
    return NextResponse.json({ error: 'This provider does not support webhooks.' }, { status: 501 });
  }

  // The raw body, never a re-serialised object: re-serialising would change
  // the bytes and break the signature — or, worse, verify a different payload
  // than the one that gets processed.
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const verification = await provider.verifyWebhook({ rawBody, headers });

  if (!verification.valid) {
    logger.warn('Rejected webhook', {
      event: 'webhook_rejected',
      status: 'invalid_signature',
      error: verification.reason,
    });
    await recordAudit({
      userId: null,
      actorType: 'WEBHOOK',
      action: 'WEBHOOK_REJECTED',
      entityType: 'webhook',
      entityId: null,
      metadata: { reason: verification.reason ?? 'unknown' },
    });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const events = provider.parseWebhook({ rawBody, headers });

  for (const event of events) {
    await processProviderEvent(provider.name, event, true);
  }

  await recordAudit({
    userId: null,
    actorType: 'WEBHOOK',
    action: 'WEBHOOK_RECEIVED',
    entityType: 'webhook',
    entityId: null,
    metadata: { provider: provider.name, events: events.length },
  });

  return NextResponse.json({ received: events.length });
}
