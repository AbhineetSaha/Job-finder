/**
 * Provider factory. This is the structural guarantee behind "no real emails
 * during development" (brief §62): the mock provider is returned unless
 * EMAIL_MODE is explicitly `production`, so forgetting to configure something
 * fails safe rather than sending.
 */
import { getEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import type { EmailProvider } from './provider.js';
import { mockProvider } from './providers/mock.js';
import { resendProvider } from './providers/resend.js';

const REAL_PROVIDERS: Record<string, EmailProvider> = {
  resend: resendProvider,
};

export function getEmailProvider(): EmailProvider {
  const env = getEnv();

  if (env.EMAIL_MODE !== 'production') {
    return mockProvider;
  }

  const provider = REAL_PROVIDERS[env.EMAIL_PROVIDER];
  if (!provider) {
    // Unreachable through normal configuration — env parsing rejects
    // production mode with a mock provider — but falling back to mock is the
    // only safe response to an unexpected value.
    logger.error('Unknown email provider requested; falling back to mock', {
      event: 'provider_resolution_failed',
      provider: env.EMAIL_PROVIDER,
    });
    return mockProvider;
  }

  return provider;
}

/** True when the resolved provider can actually transmit mail. */
export function isProviderReady(): boolean {
  return getEmailProvider().isConfigured();
}

/** Shown as a banner in the UI so the operator always knows which mode is live. */
export function describeEmailMode(): { mode: 'mock' | 'production'; provider: string; warning: string | null } {
  const env = getEnv();
  const provider = getEmailProvider();
  if (env.EMAIL_MODE !== 'production') {
    return {
      mode: 'mock',
      provider: provider.name,
      warning: null,
    };
  }
  return {
    mode: 'production',
    provider: provider.name,
    warning: 'Production sending is enabled. Approved messages will be delivered to real recipients.',
  };
}

export * from './provider.js';
export { mockProvider } from './providers/mock.js';
