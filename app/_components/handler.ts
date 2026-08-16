/**
 * Shared request handling for form POST routes.
 *
 * Every mutating handler goes through `formAction`, which enforces the session
 * check and the CSRF double-submit before the handler body runs. That ordering
 * is the point: a handler cannot forget to check, because it never receives
 * control until both have passed.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireCsrf, CsrfError } from '../../src/lib/csrf.js';
import { getCurrentUser, type AuthenticatedUser } from '../../src/lib/session.js';
import { getEnv } from '../../src/lib/env.js';
import { logger } from '../../src/lib/logger.js';

export interface ActionContext {
  user: AuthenticatedUser;
  form: FormData;
  request: NextRequest;
}

export type ActionResult = { redirect: string; error?: string; ok?: string };

function withMessage(path: string, result: ActionResult): string {
  const url = new URL(result.redirect, getEnv().APP_URL);
  if (result.error) url.searchParams.set('error', result.error);
  if (result.ok) url.searchParams.set('ok', result.ok);
  return url.toString();
}

/** Read a trimmed string field, or null when absent/blank. */
export function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function requiredField(form: FormData, name: string): string {
  const value = field(form, name);
  if (value === null) throw new ValidationError(`${name} is required.`);
  return value;
}

export function intField(form: FormData, name: string): number | null {
  const raw = field(form, name);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function formAction(
  handler: (context: ActionContext) => Promise<ActionResult>,
): (request: NextRequest, routeContext: { params: Promise<Record<string, string>> }) => Promise<NextResponse> {
  return async (request) => {
    const base = getEnv().APP_URL;

    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.redirect(new URL('/login', base), 303);
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.redirect(new URL('/?error=Malformed+request.', base), 303);
    }

    try {
      await requireCsrf(form);
    } catch (error) {
      if (error instanceof CsrfError) {
        logger.warn('CSRF validation failed', {
          event: 'csrf_failed',
          userId: user.id,
          status: 'rejected',
        });
        return NextResponse.redirect(
          new URL('/?error=Your+session+expired.+Please+try+again.', base),
          303,
        );
      }
      throw error;
    }

    try {
      const result = await handler({ user, form, request });
      return NextResponse.redirect(withMessage(result.redirect, result), 303);
    } catch (error) {
      const message =
        error instanceof ValidationError
          ? error.message
          : 'Something went wrong. Nothing was changed.';

      if (!(error instanceof ValidationError)) {
        logger.error('Form action failed', {
          event: 'form_action_failed',
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const referer = request.headers.get('referer');
      const fallback = referer ? new URL(referer).pathname : '/';
      return NextResponse.redirect(
        withMessage(fallback, { redirect: fallback, error: message }),
        303,
      );
    }
  };
}

/** GET routes that return a file. Auth is still required. */
export function downloadAction(
  handler: (user: AuthenticatedUser) => Promise<{ body: string; filename: string; contentType: string }>,
): () => Promise<NextResponse> {
  return async () => {
    const user = await getCurrentUser();
    if (!user) return NextResponse.redirect(new URL('/login', getEnv().APP_URL), 303);

    const result = await handler(user);
    return new NextResponse(result.body, {
      headers: {
        'content-type': result.contentType,
        'content-disposition': `attachment; filename="${result.filename}"`,
        // Exports contain contact data; never let an intermediary cache them.
        'cache-control': 'no-store',
      },
    });
  };
}
