import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticate } from '../../../../src/services/users.js';
import { createSession } from '../../../../src/lib/session.js';
import { getEnv } from '../../../../src/lib/env.js';

const schema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(500),
});

function clientIp(request: NextRequest): string | null {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    null
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const parsed = schema.safeParse({
    email: form.get('email'),
    password: form.get('password'),
  });

  const base = getEnv().APP_URL;

  if (!parsed.success) {
    return NextResponse.redirect(new URL('/login?error=Invalid+email+or+password.', base), 303);
  }

  const result = await authenticate(parsed.data.email, parsed.data.password, clientIp(request));
  if (!result.ok) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(result.error)}`, base),
      303,
    );
  }

  await createSession(result.user.id, {
    userAgent: request.headers.get('user-agent'),
    ip: clientIp(request),
  });

  return NextResponse.redirect(new URL('/', base), 303);
}
