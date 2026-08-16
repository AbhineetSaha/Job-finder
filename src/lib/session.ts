/**
 * Session management. Opaque random tokens, stored only as SHA-256 hashes.
 *
 * A database read is required per request. For a single-operator tool that is
 * the right trade: revocation is immediate and there is no signed-token replay
 * window to reason about.
 */
import { cookies } from 'next/headers';
import { and, eq, gt, lt } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { sessions, users, type User } from '../db/schema.js';
import { generateToken, sha256 } from './crypto.js';
import { getEnv } from './env.js';

export const SESSION_COOKIE = 'outreach_session';
export const CSRF_COOKIE = 'outreach_csrf';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: 'OWNER' | 'OPERATOR';
}

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: getEnv().NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** Create a session and set both the session and CSRF cookies. */
export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<void> {
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await getDb().insert(sessions).values({
    userId,
    tokenHash: sha256(token),
    expiresAt,
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, cookieOptions(Math.floor(SESSION_TTL_MS / 1000)));
  // Double-submit CSRF token. Readable by the server on POST and embedded in
  // every form; not HttpOnly is unnecessary here because forms are server-rendered.
  store.set(CSRF_COOKIE, generateToken(24), cookieOptions(Math.floor(SESSION_TTL_MS / 1000)));
}

/** Resolve the current user, or null. Expired sessions are treated as absent. */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = getDb();
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      role: users.role,
      disabledAt: users.disabledAt,
      sessionId: sessions.id,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row || row.disabledAt) return null;

  // Sliding activity marker. Not awaited on the read path's critical latency,
  // but errors must not surface as a failed page render.
  void getDb()
    .update(sessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(sessions.id, row.sessionId))
    .catch(() => undefined);

  return { id: row.userId, email: row.email, role: row.role };
}

/** Throwing variant for pages and handlers that require authentication. */
export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Authentication required');
    this.name = 'UnauthorizedError';
  }
}

/** Delete the session row so a stolen cookie stops working immediately. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await getDb().delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  }
  store.delete(SESSION_COOKIE);
  store.delete(CSRF_COOKIE);
}

/** Housekeeping, run by the scheduler. */
export async function purgeExpiredSessions(): Promise<number> {
  const deleted = await getDb()
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return deleted.length;
}

export async function getUserById(userId: string): Promise<User | null> {
  const rows = await getDb().select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}
