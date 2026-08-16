/**
 * Cryptographic primitives, all from node:crypto — no dependency.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** `scrypt$N$r$p$salt$hash`, all base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Constant-time password verification. Returns false rather than throwing on a
 * malformed stored hash, so a corrupt row cannot become an authentication bypass.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const saltPart = parts[4];
  const hashPart = parts[5];
  if (!saltPart || !hashPart) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltPart, 'base64url');
    expected = Buffer.from(hashPart, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(password, salt, expected.length);
  return safeEqual(derived, expected);
}

/**
 * A fixed-cost verification against a throwaway hash. Used on the login path
 * when the account does not exist, so response timing does not reveal whether
 * an email is registered.
 */
const DUMMY_HASH_PROMISE = hashPassword('outreach-dummy-password-for-timing-equalisation');

export async function dummyVerify(password: string): Promise<false> {
  await verifyPassword(password, await DUMMY_HASH_PROMISE);
  return false;
}

export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const bufA = typeof a === 'string' ? Buffer.from(a, 'utf8') : a;
  const bufB = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
  // timingSafeEqual throws on length mismatch; compare lengths first, which is
  // safe because length is not secret here (tokens are fixed width).
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** An opaque, unguessable token. The raw value is shown once; only its hash is stored. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Content hash binding an approval to exact message content. Any edit to
 * recipient, subject, or body changes this and invalidates the approval.
 */
export function contentHash(recipient: string, subject: string, body: string): string {
  return sha256(
    JSON.stringify({
      recipient: recipient.trim().toLowerCase(),
      subject: subject.trim(),
      body: body.trim(),
    }),
  );
}

/**
 * Deterministic idempotency key. Two workers computing this for the same
 * message and attempt produce the same value, and the unique index on it stops
 * the second from sending.
 */
export function idempotencyKey(messageId: string, attemptNumber: number): string {
  return sha256(`message:${messageId}:attempt:${attemptNumber}`);
}
