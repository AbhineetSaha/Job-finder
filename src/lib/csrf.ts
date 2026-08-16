/**
 * CSRF protection: double-submit cookie.
 *
 * A random value lives in a SameSite=Lax cookie and is embedded in every form.
 * A cross-site POST can cause the browser to send the cookie but cannot read
 * it to populate the form field, so the comparison fails.
 *
 * Webhook routes are deliberately exempt — no cookie participates in those
 * requests, and they are authenticated by HMAC instead.
 */
import { cookies } from 'next/headers';
import { safeEqual } from './crypto.js';
import { CSRF_COOKIE, CSRF_FIELD } from './constants.js';

export { CSRF_FIELD };

/** The token to embed in a form. Returns empty string when unauthenticated. */
export async function getCsrfToken(): Promise<string> {
  const store = await cookies();
  return store.get(CSRF_COOKIE)?.value ?? '';
}

export class CsrfError extends Error {
  constructor() {
    super('CSRF validation failed');
    this.name = 'CsrfError';
  }
}

/**
 * Verify a submitted token against the cookie. Throws on mismatch so a handler
 * cannot accidentally proceed by ignoring a boolean return.
 */
export async function requireCsrf(formData: FormData): Promise<void> {
  const submitted = formData.get(CSRF_FIELD);
  if (typeof submitted !== 'string' || submitted.length === 0) throw new CsrfError();

  const store = await cookies();
  const expected = store.get(CSRF_COOKIE)?.value;
  if (!expected) throw new CsrfError();

  if (!safeEqual(submitted, expected)) throw new CsrfError();
}
