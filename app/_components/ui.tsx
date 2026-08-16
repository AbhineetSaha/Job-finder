/**
 * Shared presentational helpers.
 *
 * Everything here renders through JSX, so React escapes all interpolated
 * prospect data. There is deliberately no dangerouslySetInnerHTML anywhere in
 * the codebase, and a security test asserts that.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CSRF_FIELD } from '../../src/lib/constants.js';

export function Csrf({ token }: { token: string }) {
  return <input type="hidden" name={CSRF_FIELD} value={token} />;
}

export function Stat({ label, value, href }: { label: string; value: ReactNode; href?: string }) {
  const body = (
    <div className="card stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
  return href ? (
    <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>
      {body}
    </Link>
  ) : (
    body
  );
}

const BAND_CLASS: Record<string, string> = {
  HIGH_PRIORITY: 'ok',
  STRONG: 'ok',
  POTENTIAL: '',
  WEAK: 'warn',
  POOR: 'danger',
};

export function ScoreBadge({ score, band }: { score: number | null; band: string | null }) {
  if (score === null || band === null) return <span className="badge muted">Not scored</span>;
  return (
    <span className={`badge ${BAND_CLASS[band] ?? ''}`}>
      {score} · {band.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

const STATUS_CLASS: Record<string, string> = {
  WON: 'ok',
  REPLIED: 'ok',
  MEETING_BOOKED: 'ok',
  LOST: 'danger',
  NOT_INTERESTED: 'danger',
  DO_NOT_CONTACT: 'danger',
  BOUNCED: 'danger',
  INVALID: 'danger',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_CLASS[status] ?? ''}`}>{status.replace(/_/g, ' ')}</span>;
}

/**
 * Renders an external link only when the URL passed validation. Prospect data
 * is untrusted; a `javascript:` URL must never become a clickable href.
 */
export function SafeLink({ href, children }: { href: string | null; children?: ReactNode }) {
  if (!href) return <span className="muted">—</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children ?? href}
    </a>
  );
}

export function Notice({ kind, children }: { kind: 'error' | 'ok'; children: ReactNode }) {
  return <div className={`notice ${kind}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>;
}

export function formatDate(value: Date | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value);
}

export function money(value: string | null | undefined, currency = 'USD'): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}
