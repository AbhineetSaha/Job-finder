/**
 * Authenticated shell. Every page inside this group requires a session, and
 * the production-sending banner is always visible so the operator can never be
 * unsure which mode is live (brief §63).
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getCurrentUser } from '../../src/lib/session.js';
import { describeEmailMode } from '../../src/email/index.js';
import { getConfig } from '../../src/services/config.js';

const NAV = [
  ['/', 'Dashboard'],
  ['/discovery', 'Discovery'],
  ['/prospects', 'Prospects'],
  ['/review', 'Review queue'],
  ['/campaigns', 'Campaigns'],
  ['/conversations', 'Conversations'],
  ['/pipeline', 'Pipeline'],
  ['/analytics', 'Analytics'],
  ['/settings', 'Settings'],
] as const;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const mode = describeEmailMode();
  const config = await getConfig(user.id);

  return (
    <>
      {config.globalSendPaused ? (
        <div className="banner paused">
          All sending is paused{config.globalPauseReason ? `: ${config.globalPauseReason}` : ''}.{' '}
          <Link href="/settings">Manage</Link>
        </div>
      ) : mode.mode === 'production' ? (
        <div className="banner production">PRODUCTION SENDING IS LIVE — {mode.warning}</div>
      ) : (
        <div className="banner mock">
          Mock email mode. Nothing is delivered to real recipients. Provider: {mode.provider}.
        </div>
      )}

      <div className="layout">
        <nav className="sidebar">
          <div className="brand">Outreach</div>
          {NAV.map(([href, label]) => (
            <Link key={href} href={href}>
              {label}
            </Link>
          ))}
          <form action="/api/auth/logout" method="post" style={{ marginTop: 16 }}>
            <button type="submit">Sign out</button>
          </form>
          <p className="small muted" style={{ marginTop: 12 }}>
            {user.email}
          </p>
        </nav>
        <main>{children}</main>
      </div>
    </>
  );
}
