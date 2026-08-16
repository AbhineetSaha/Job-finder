import { formAction, field, intField, requiredField } from '../../../_components/handler.js';
import { createDiscoverySource } from '../../../../src/services/discovery.js';

/** Split a comma-separated input into a clean array. */
function list(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export const POST = formAction(async ({ user, form }) => {
  const kind = requiredField(form, 'kind');

  // Only the keys the chosen adapter understands are stored, so a stray field
  // from the shared form does not end up in another source's config.
  const config: Record<string, unknown> = {
    limit: intField(form, 'limit') ?? 50,
    minMatchScore: intField(form, 'minMatchScore') ?? 0,
  };

  if (kind === 'hacker-news') {
    config.keywords = list(field(form, 'keywords'));
    config.monthsBack = 2;
  }
  if (kind === 'github') {
    config.languages = list(field(form, 'languages'));
    const token = field(form, 'token');
    if (token) config.token = token;
  }
  if (kind === 'sec-form-d') {
    config.sicPrefixes = list(field(form, 'sicPrefixes'));
    config.daysBack = 5;
  }

  const result = await createDiscoverySource({
    userId: user.id,
    kind,
    name: requiredField(form, 'name'),
    config,
  });

  if (!result.ok) return { redirect: '/discovery', error: result.error };
  return { redirect: '/discovery', ok: `Source "${result.source.name}" added.` };
});
