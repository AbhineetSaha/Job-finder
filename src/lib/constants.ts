/**
 * Values shared between server and client bundles.
 *
 * Kept separate from lib/session.ts and lib/csrf.ts because those import
 * `next/headers` and the database, which must never be pulled into a client
 * component just to read a cookie name.
 */
export const SESSION_COOKIE = 'outreach_session';
export const CSRF_COOKIE = 'outreach_csrf';
export const CSRF_FIELD = '_csrf';
