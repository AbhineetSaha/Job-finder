import { NextResponse } from 'next/server';
import { getCurrentUser } from '../../../src/lib/session.js';
import { getMetricsForApi } from '../../../src/services/ops.js';

export const dynamic = 'force-dynamic';

/** Session-protected: operational counters are not public. */
export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return NextResponse.json(await getMetricsForApi(user.id), {
    headers: { 'cache-control': 'no-store' },
  });
}
