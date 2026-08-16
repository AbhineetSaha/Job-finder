/**
 * User accounts and login.
 *
 * Registration is closed: there is no public sign-up route. The first user is
 * created from the CLI (`npm run outreach -- user create`). For a
 * single-operator tool, an open registration endpoint is pure attack surface.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { services, settings, templates, userProfiles, users, type User } from '../db/schema.js';
import { normalizeEmail } from '../domain/normalize.js';
import { extractVariables } from '../domain/template.js';
import { dummyVerify, hashPassword, verifyPassword } from '../lib/crypto.js';
import { recordAudit } from './audit.js';
import { logger } from '../lib/logger.js';
import { DEFAULT_SERVICES, DEFAULT_TEMPLATES } from './defaults.js';

const MIN_PASSWORD_LENGTH = 12;

/** In-process login throttle. Per-IP and per-account, with a lockout window. */
const attempts = new Map<string, { count: number; firstAt: number }>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

function throttleKey(kind: 'ip' | 'email', value: string): string {
  return `${kind}:${value}`;
}

function isThrottled(key: string): boolean {
  const record = attempts.get(key);
  if (!record) return false;
  if (Date.now() - record.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordAttempt(key: string): void {
  const record = attempts.get(key);
  if (!record || Date.now() - record.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  record.count += 1;
}

function clearAttempts(key: string): void {
  attempts.delete(key);
}

export interface CreateUserInput {
  email: string;
  password: string;
  name?: string;
  role?: 'OWNER' | 'OPERATOR';
}

export async function createUser(
  input: CreateUserInput,
): Promise<{ ok: true; user: User } | { ok: false; error: string }> {
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) return { ok: false, error: 'A valid email address is required.' };
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const db = getDb();
  const passwordHash = await hashPassword(input.password);

  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(users)
        .values({
          email: input.email.trim(),
          normalizedEmail,
          passwordHash,
          role: input.role ?? 'OWNER',
        })
        .returning();

      const user = inserted[0];
      if (!user) return { ok: false as const, error: 'Could not create the user.' };

      await tx.insert(userProfiles).values({
        userId: user.id,
        name: input.name ?? '',
        email: input.email.trim(),
      });

      await tx.insert(settings).values({ userId: user.id });

      // Seed the configurable offering and templates so the system is usable
      // immediately. Everything here is editable; none of it is hard-coded
      // anywhere else (brief §16, §41).
      await tx.insert(services).values(
        DEFAULT_SERVICES.map((service, index) => ({
          userId: user.id,
          key: service.key,
          name: service.name,
          description: service.description,
          bullets: service.bullets,
          technologies: service.technologies,
          sortOrder: index,
        })),
      );

      await tx.insert(templates).values(
        DEFAULT_TEMPLATES.map((template) => ({
          userId: user.id,
          name: template.name,
          kind: template.kind,
          subjectTemplate: template.subject,
          bodyTemplate: template.body,
          requiredVariables: [
            ...new Set([...extractVariables(template.subject), ...extractVariables(template.body)]),
          ],
        })),
      );

      await recordAudit(
        {
          userId: user.id,
          action: 'USER_CREATED',
          entityType: 'user',
          entityId: user.id,
          metadata: { email: normalizedEmail, role: user.role },
        },
        tx,
      );

      return { ok: true as const, user };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('duplicate key')) {
      return { ok: false, error: 'An account with that email already exists.' };
    }
    logger.error('User creation failed', { event: 'user_create_failed', error: message });
    return { ok: false, error: 'Could not create the user.' };
  }
}

/**
 * Verify credentials.
 *
 * An unknown account still performs a full scrypt verification against a dummy
 * hash, so response timing does not reveal whether an email is registered.
 */
export async function authenticate(
  email: string,
  password: string,
  ip?: string | null,
): Promise<{ ok: true; user: User } | { ok: false; error: string }> {
  const normalizedEmail = normalizeEmail(email);
  const ipKey = throttleKey('ip', ip ?? 'unknown');
  const emailKey = throttleKey('email', normalizedEmail ?? 'unknown');

  if (isThrottled(ipKey) || isThrottled(emailKey)) {
    return { ok: false, error: 'Too many attempts. Try again in a few minutes.' };
  }

  recordAttempt(ipKey);
  recordAttempt(emailKey);

  if (!normalizedEmail) {
    await dummyVerify(password);
    return { ok: false, error: 'Invalid email or password.' };
  }

  const rows = await getDb()
    .select()
    .from(users)
    .where(eq(users.normalizedEmail, normalizedEmail))
    .limit(1);

  const user = rows[0];
  if (!user) {
    await dummyVerify(password);
    return { ok: false, error: 'Invalid email or password.' };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    await recordAudit({
      userId: user.id,
      action: 'USER_LOGIN_FAILED',
      entityType: 'user',
      entityId: user.id,
      metadata: {},
      ip: ip ?? null,
    });
    return { ok: false, error: 'Invalid email or password.' };
  }

  if (user.disabledAt) return { ok: false, error: 'This account is disabled.' };

  clearAttempts(ipKey);
  clearAttempts(emailKey);

  await recordAudit({
    userId: user.id,
    action: 'USER_LOGIN',
    entityType: 'user',
    entityId: user.id,
    metadata: {},
    ip: ip ?? null,
  });

  return { ok: true, user };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user) return { ok: false, error: 'User not found.' };

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return { ok: false, error: 'Current password is incorrect.' };
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, userId));

  return { ok: true };
}

export async function getProfile(userId: string) {
  const rows = await getDb()
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateProfile(
  userId: string,
  changes: Partial<{
    name: string;
    title: string;
    bio: string;
    location: string;
    timezone: string;
    email: string;
    phone: string;
    portfolioUrl: string | null;
    githubUrl: string | null;
    linkedinUrl: string | null;
    skills: string[];
    industries: string[];
    hourlyRate: string | null;
    minimumProjectValue: string | null;
    availability: string;
  }>,
): Promise<{ ok: boolean }> {
  await getDb()
    .update(userProfiles)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(userProfiles.userId, userId));

  await recordAudit({
    userId,
    action: 'SETTINGS_UPDATED',
    entityType: 'user_profile',
    entityId: userId,
    metadata: { fields: Object.keys(changes) },
  });

  return { ok: true };
}

export async function countUsers(): Promise<number> {
  const rows = await getDb().select({ count: sql<number>`count(*)::int` }).from(users);
  return rows[0]?.count ?? 0;
}

/** Recent failed logins, for the operations page. */
export async function getRecentFailedLogins(userId: string, sinceHours = 24) {
  const { auditLogs } = await import('../db/schema.js');
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  return getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.userId, userId),
        eq(auditLogs.action, 'USER_LOGIN_FAILED'),
        gte(auditLogs.createdAt, since),
      ),
    );
}
