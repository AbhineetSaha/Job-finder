/**
 * Prospect detail: the research workstation.
 *
 * Everything needed to answer the ten questions of brief §15, score the
 * prospect, and compose a personalised draft, on one page next to the
 * timeline of what has already happened.
 */
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { requireUser } from '../../../../src/lib/session.js';
import { getCsrfToken } from '../../../../src/lib/csrf.js';
import { getDb } from '../../../../src/db/client.js';
import { services, templates } from '../../../../src/db/schema.js';
import { getProspect } from '../../../../src/services/prospects.js';
import { assessCompleteness, getResearch, RESEARCH_FIELDS } from '../../../../src/services/research.js';
import { getLatestSignals } from '../../../../src/services/qualification.js';
import { getConversation, getDeal } from '../../../../src/services/crm.js';
import {
  SIGNAL_HELP,
  SIGNAL_KEYS,
  SIGNAL_LABELS,
  scoreProspect,
} from '../../../../src/domain/qualification.js';
import { roleCategoryLabel } from '../../../../src/domain/roles.js';
import { allowedTransitions, type ProspectStatus } from '../../../../src/domain/status.js';
import { Csrf, Empty, Notice, SafeLink, ScoreBadge, StatusBadge, formatDate, money } from '../../../_components/ui.js';

export const dynamic = 'force-dynamic';

export default async function ProspectDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const csrf = await getCsrfToken();

  const record = await getProspect(user.id, id);
  if (!record) notFound();

  const { prospect, company, contact } = record;

  const [researchRecord, signals, conversation, deal, serviceRows, templateRows] = await Promise.all([
    getResearch(user.id, id),
    getLatestSignals(id),
    getConversation(user.id, id),
    getDeal(user.id, id),
    getDb().select().from(services).where(eq(services.userId, user.id)),
    getDb().select().from(templates).where(eq(templates.userId, user.id)),
  ]);

  const preview = scoreProspect(signals);
  const completeness = researchRecord
    ? assessCompleteness(researchRecord.research, researchRecord.sources)
    : null;
  const sourcesByField = new Map<string, { url: string; title: string | null }[]>();
  for (const source of researchRecord?.sources ?? []) {
    const list = sourcesByField.get(source.field) ?? [];
    list.push({ url: source.url, title: source.title });
    sourcesByField.set(source.field, list);
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>{company.name}</h1>
          <p className="muted small">
            {contact.fullName} · {contact.role ?? 'Role unknown'} ·{' '}
            {roleCategoryLabel(contact.roleCategory)} · <span className="mono">{contact.email}</span>
          </p>
        </div>
        <div className="row">
          <StatusBadge status={prospect.status} />
          <ScoreBadge score={prospect.qualificationScore} band={prospect.qualificationBand} />
        </div>
      </div>

      {query.error ? <Notice kind="error">{query.error}</Notice> : null}
      {query.ok ? <Notice kind="ok">{query.ok}</Notice> : null}

      {contact.roleCategory === 'OTHER' || contact.roleCategory === 'UNKNOWN' ? (
        <Notice kind="error">
          This contact is not recognised as a technical decision maker. Confirm they are the right
          person before reaching out.
        </Notice>
      ) : null}

      <div className="card">
        <div className="grid">
          <div>
            <div className="label">Domain</div>
            <SafeLink href={company.website}>{company.normalizedDomain ?? '—'}</SafeLink>
          </div>
          <div>
            <div className="label">Location</div>
            {company.city ?? '—'}
            {company.state ? `, ${company.state}` : ''} ({company.country})
          </div>
          <div>
            <div className="label">Timezone</div>
            {contact.timezone ?? company.timezone ?? 'Unknown'}
          </div>
          <div>
            <div className="label">Industry</div>
            {company.industry ?? '—'}
          </div>
          <div>
            <div className="label">Size / stage</div>
            {company.companySize ?? '—'} / {company.fundingStage ?? '—'}
          </div>
          <div>
            <div className="label">Source</div>
            <SafeLink href={company.sourceUrl}>{company.source}</SafeLink>
          </div>
          <div>
            <div className="label">Last contacted</div>
            {formatDate(prospect.lastContactedAt)}
          </div>
          <div>
            <div className="label">Deal</div>
            {deal ? money(deal.estimatedValue, deal.currency) : '—'}
          </div>
        </div>
        {contact.contactReason ? (
          <p className="small" style={{ marginBottom: 0 }}>
            <strong>Why this person:</strong> {contact.contactReason}
          </p>
        ) : null}
      </div>

      {/* ---------------------------------------------------------------- */}
      <h2>Qualification</h2>
      <p className="muted small">
        Preview: {preview.score}/100 — {preview.band.replace(/_/g, ' ').toLowerCase()}. Unknown
        signals score zero and are never guessed; they are research to do.
      </p>

      <form action={`/api/qualify/${prospect.id}`} method="post" className="card">
        <Csrf token={csrf} />
        <div className="grid">
          {SIGNAL_KEYS.map((key) => (
            <div key={key} className="field">
              <label htmlFor={key}>{SIGNAL_LABELS[key]}</label>
              <select id={key} name={key} defaultValue={signals[key]}>
                <option value="UNKNOWN">Unknown</option>
                <option value="YES">Yes</option>
                <option value="NO">No</option>
              </select>
              <div className="small muted">{SIGNAL_HELP[key]}</div>
            </div>
          ))}
        </div>
        <button type="submit" className="primary">
          Score prospect
        </button>
      </form>

      {/* ---------------------------------------------------------------- */}
      <h2>Research</h2>
      {completeness ? (
        <p className="muted small">
          {completeness.percentComplete}% complete.{' '}
          {completeness.unsourced.length > 0
            ? `${completeness.unsourced.length} answered field(s) have no source URL and are shown as unverified.`
            : 'Every answered field has a source.'}
        </p>
      ) : null}

      <form action={`/api/research/${prospect.id}`} method="post" className="card">
        <Csrf token={csrf} />
        {RESEARCH_FIELDS.map((field) => {
          const value = researchRecord?.research[field.key] ?? '';
          const fieldSources = sourcesByField.get(field.key) ?? [];
          return (
            <div className="field" key={field.key}>
              <label htmlFor={field.key}>
                {field.question}
                {value && fieldSources.length === 0 ? (
                  <span className="badge warn" style={{ marginLeft: 8 }}>
                    unverified
                  </span>
                ) : null}
              </label>
              <textarea id={field.key} name={field.key} defaultValue={value} maxLength={5000} />
              <input
                name={`source__${field.key}`}
                placeholder="Source URL for this answer (optional)"
                defaultValue={fieldSources[0]?.url ?? ''}
                maxLength={500}
                style={{ marginTop: 4 }}
              />
              {fieldSources.length > 0 ? (
                <div className="small muted">
                  Source: <SafeLink href={fieldSources[0]?.url ?? null} />
                </div>
              ) : null}
            </div>
          );
        })}
        <div className="field">
          <label htmlFor="additionalNotes">Additional notes</label>
          <textarea
            id="additionalNotes"
            name="additionalNotes"
            defaultValue={researchRecord?.research.additionalNotes ?? ''}
            maxLength={5000}
          />
        </div>
        <button type="submit" className="primary">
          Save research
        </button>
      </form>

      {/* ---------------------------------------------------------------- */}
      <h2>Compose outreach</h2>
      <p className="muted small">
        Every personalisation field below is written by you. If a template needs a value you have
        not supplied, the draft is refused rather than rendered with a blank or an invention.
      </p>

      <form action={`/api/drafts/${prospect.id}`} method="post" className="card">
        <Csrf token={csrf} />
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="templateId">Template</label>
            <select id="templateId" name="templateId" required>
              {templateRows.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.kind})
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="serviceId">Relevant service</label>
            <select id="serviceId" name="serviceId" defaultValue={prospect.serviceId ?? ''} required>
              <option value="">Select a service…</option>
              {serviceRows.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor="specificObservation">Specific observation (something concretely true)</label>
          <input id="specificObservation" name="specificObservation" maxLength={500} />
        </div>
        <div className="field">
          <label htmlFor="engineeringSignal">Engineering signal</label>
          <input id="engineeringSignal" name="engineeringSignal" maxLength={500} />
        </div>
        <div className="field">
          <label htmlFor="painPoint">Pain point</label>
          <input id="painPoint" name="painPoint" maxLength={500} />
        </div>
        <div className="field">
          <label htmlFor="whyRelevant">Why you are relevant</label>
          <input id="whyRelevant" name="whyRelevant" maxLength={500} />
        </div>
        <div className="field">
          <label htmlFor="specificOffer">Specific offer</label>
          <input id="specificOffer" name="specificOffer" maxLength={500} />
        </div>
        <div className="field">
          <label htmlFor="relevantTechnology">Relevant technology</label>
          <input id="relevantTechnology" name="relevantTechnology" maxLength={200} />
        </div>

        <button type="submit" className="primary">
          Create draft for review
        </button>
      </form>

      {/* ---------------------------------------------------------------- */}
      <h2>Status</h2>
      <form action={`/api/prospects/${prospect.id}/status`} method="post" className="card row">
        <Csrf token={csrf} />
        <div style={{ flex: '1 1 220px' }}>
          <label htmlFor="status">Move to</label>
          <select id="status" name="status" required>
            {allowedTransitions(prospect.status as ProspectStatus).map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '2 1 260px' }}>
          <label htmlFor="reason">Reason (optional)</label>
          <input id="reason" name="reason" maxLength={500} />
        </div>
        <button type="submit">Change status</button>
      </form>

      {/* ---------------------------------------------------------------- */}
      <h2>Timeline</h2>
      {conversation.length === 0 ? (
        <Empty>Nothing has happened yet.</Empty>
      ) : (
        <ul className="timeline">
          {conversation
            .slice()
            .reverse()
            .map((entry) => (
              <li key={`${entry.kind}-${entry.id}`}>
                <div className="small muted">
                  {formatDate(entry.at)} · {entry.kind}
                  {entry.status ? ` · ${entry.status}` : ''}
                </div>
                <div>
                  <strong>{entry.title}</strong>
                </div>
                {entry.body && entry.kind !== 'ACTIVITY' ? (
                  <pre className="email" style={{ marginTop: 6 }}>
                    {entry.body}
                  </pre>
                ) : entry.body ? (
                  <div className="small">{entry.body}</div>
                ) : null}
              </li>
            ))}
        </ul>
      )}
    </>
  );
}
