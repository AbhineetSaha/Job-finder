import { NextResponse, type NextRequest } from 'next/server';
import { destroySession } from '../../../../src/lib/session.js';
import { getEnv } from '../../../../src/lib/env.js';

export async function POST(_request: NextRequest): Promise<NextResponse> {
  await destroySession();
  return NextResponse.redirect(new URL('/login', getEnv().APP_URL), 303);
}
