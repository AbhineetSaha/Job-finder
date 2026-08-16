/**
 * Sign-in. There is no public registration route by design: the first user is
 * created from the CLI (`npm run outreach -- user create`).
 */
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../src/lib/session.js';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getCurrentUser()) redirect('/');
  const params = await searchParams;

  return (
    <main style={{ maxWidth: 360, margin: '80px auto' }}>
      <h1>Outreach</h1>
      <p className="muted small">Sign in to continue.</p>

      {params.error ? <div className="notice error">{params.error}</div> : null}

      <form action="/api/auth/login" method="post" style={{ marginTop: 20 }}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <button type="submit" className="primary">
          Sign in
        </button>
      </form>
    </main>
  );
}
