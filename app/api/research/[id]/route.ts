import { formAction, field } from '../../../_components/handler.js';
import { RESEARCH_FIELDS, saveResearch, type ResearchFieldKey } from '../../../../src/services/research.js';

export const POST = formAction(async ({ user, form, request }) => {
  const id = request.nextUrl.pathname.split('/').at(-1) as string;

  const fields: Partial<Record<ResearchFieldKey | 'additionalNotes', string | null>> = {
    additionalNotes: field(form, 'additionalNotes'),
  };
  const sources: { field: string; url: string }[] = [];

  for (const definition of RESEARCH_FIELDS) {
    fields[definition.key] = field(form, definition.key);
    const url = field(form, `source__${definition.key}`);
    if (url) sources.push({ field: definition.key, url });
  }

  const result = await saveResearch({ userId: user.id, prospectId: id, fields, sources });
  if (!result.ok) return { redirect: `/prospects/${id}`, error: result.error };

  return {
    redirect: `/prospects/${id}`,
    ok: `Research saved — ${result.completeness.percentComplete}% complete.`,
  };
});
