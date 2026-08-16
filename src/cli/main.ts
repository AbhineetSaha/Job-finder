#!/usr/bin/env node
/**
 * `outreach` CLI.
 *
 * Everything here is a thin wrapper over the same services the web UI uses, so
 * a command can never bypass a safety check that the UI enforces. In
 * particular there is no "send this now" command that skips approval.
 *
 * Usage: npm run outreach -- <group> <command> [options]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client.js';
import { campaigns, messages, users } from '../db/schema.js';
import { getEnv } from '../lib/env.js';
import { parseImportCsv } from '../domain/csv.js';
import { coerceSignals, SIGNAL_KEYS } from '../domain/qualification.js';
import { describeWindows } from '../domain/window.js';
import { createUser } from '../services/users.js';
import { importProspects, listProspects } from '../services/prospects.js';
import { qualifyProspect } from '../services/qualification.js';
import { getMessage, approveDraft, getReviewQueue } from '../services/drafts.js';
import { listCampaigns, setCampaignStatus, type CampaignStatus } from '../services/campaigns.js';
import { addSuppression, listSuppressions, type SuppressionReason } from '../services/suppression.js';
import { getAnalytics, getCampaignPerformance } from '../services/analytics.js';
import {
  exportActivitiesCsv,
  exportProspectsCsv,
  getOperationsSnapshot,
  retryFailedMessage,
  setGlobalPause,
} from '../services/ops.js';
import { getQueueStats, listFailedJobs, releaseStuckJobs, retryJob } from '../queue/queue.js';
import {
  createDiscoverySource,
  getDiscoveryCounts,
  listCandidates,
  listDiscoveryRuns,
  listDiscoverySources,
  listSources,
  promoteCandidate,
  rejectCandidate,
  runDiscovery,
} from '../services/discovery.js';

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

interface Args {
  positional: string[];
  options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, options };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function table(rows: Record<string, string | number | null>[]): void {
  if (rows.length === 0) {
    out('(none)');
    return;
  }
  const columns = Object.keys(rows[0] as object);
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column] ?? '').length)),
  );

  out(columns.map((c, i) => c.toUpperCase().padEnd(widths[i] as number)).join('  '));
  out(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    out(columns.map((c, i) => String(row[c] ?? '').padEnd(widths[i] as number)).join('  '));
  }
}

class CliError extends Error {}

function required(args: Args, name: string): string {
  const value = args.options[name];
  if (typeof value !== 'string' || !value) throw new CliError(`--${name} is required.`);
  return value;
}

/**
 * Resolve the operating user. Single-operator systems have exactly one; with
 * more than one, --user disambiguates rather than the CLI guessing.
 */
async function resolveUserId(args: Args): Promise<string> {
  const explicit = args.options.user;
  const db = getDb();

  if (typeof explicit === 'string') {
    const rows = await db.select().from(users).where(eq(users.email, explicit)).limit(1);
    const user = rows[0];
    if (!user) throw new CliError(`No user with email ${explicit}.`);
    return user.id;
  }

  const all = await db.select({ id: users.id, email: users.email }).from(users).limit(2);
  if (all.length === 0) {
    throw new CliError('No users exist. Create one with: outreach user create --email … --password …');
  }
  if (all.length > 1) {
    throw new CliError('More than one user exists. Pass --user <email>.');
  }
  return all[0]!.id;
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

const HELP = `outreach — US freelance client acquisition

  user create        --email --password [--name]

  prospect import    --file <csv> [--dry-run]
  prospect list      [--status] [--min-score] [--limit]
  prospect score     --id <prospect> --signals usCompany=YES,hiringEngineers=YES
  prospect export    [--out <file>]

  campaign list
  campaign start     --id <campaign>
  campaign pause     --id <campaign>
  campaign resume    --id <campaign>

  email preview      --id <message>
  email queue                          # messages awaiting approval
  email approve      --id <message>    # records an explicit human approval

  suppression add    --email <address> | --domain <domain> [--reason]
  suppression list

  discover sources                     # what adapters exist
  discover list                        # configured sources
  discover add       --kind <adapter> --name <label> [--keywords|--languages|--sic] [--limit] [--min-score]
  discover run       --id <source> [--limit]
  discover candidates [--status NEW] [--min-score] [--source] [--limit]
  discover promote   --id <candidate> [--email] [--name] [--role] [--acknowledge-consent]
  discover reject    --id <candidate> [--note]
  discover runs

  analytics
  ops pause-all      [--reason]
  ops resume-all
  ops queue
  ops failed
  ops retry          --message <id> | --job <id>
  ops unstick
  ops export-activities [--out <file>]

Global: --user <email> selects the operator when more than one exists.
`;

async function run(args: Args): Promise<void> {
  const [group, command] = args.positional;

  if (!group || group === 'help' || args.options.help) {
    out(HELP);
    return;
  }

  /* ----- user ----- */
  if (group === 'user' && command === 'create') {
    const result = await createUser({
      email: required(args, 'email'),
      password: required(args, 'password'),
      ...(typeof args.options.name === 'string' ? { name: args.options.name } : {}),
    });
    if (!result.ok) throw new CliError(result.error);
    out(`Created user ${result.user.email} (${result.user.id}).`);
    out('Default services and email templates were created and can be edited in Settings.');
    return;
  }

  /* ----- prospect ----- */
  if (group === 'prospect') {
    const userId = await resolveUserId(args);

    if (command === 'import') {
      const csv = await readFile(required(args, 'file'), 'utf8');
      const parsed = parseImportCsv(csv);

      if (parsed.missingColumns.length > 0) {
        throw new CliError(`Missing required column(s): ${parsed.missingColumns.join(', ')}`);
      }

      out(`${parsed.valid.length} valid, ${parsed.invalid.length} rejected.`);
      for (const row of parsed.invalid.slice(0, 20)) {
        out(`  row ${row.rowNumber}: ${row.errors.join('; ')}`);
      }

      if (args.options['dry-run']) {
        out('Dry run — nothing was written.');
        return;
      }

      const summary = await importProspects(userId, parsed.valid);
      out(`Imported ${summary.created}, skipped ${summary.skipped} duplicate(s), ${summary.failed} failed.`);
      return;
    }

    if (command === 'list') {
      const result = await listProspects(
        userId,
        {
          ...(typeof args.options.status === 'string'
            ? { status: [args.options.status as never] }
            : {}),
          ...(typeof args.options['min-score'] === 'string'
            ? { minScore: Number(args.options['min-score']) }
            : {}),
        },
        1,
        Number(args.options.limit ?? 25),
      );

      table(
        result.items.map(({ prospect, company, contact }) => ({
          id: prospect.id.slice(0, 8),
          company: company.name.slice(0, 28),
          contact: contact.fullName.slice(0, 22),
          email: contact.email.slice(0, 32),
          score: prospect.qualificationScore ?? '—',
          status: prospect.status,
        })),
      );
      out(`\n${result.total} total.`);
      return;
    }

    if (command === 'score') {
      const id = required(args, 'id');
      const raw = required(args, 'signals');

      const parsed: Record<string, unknown> = {};
      for (const pair of raw.split(',')) {
        const [key, value] = pair.split('=').map((s) => s.trim());
        if (key && value) parsed[key] = value.toUpperCase();
      }

      const unknownKeys = Object.keys(parsed).filter(
        (k) => !(SIGNAL_KEYS as readonly string[]).includes(k),
      );
      if (unknownKeys.length > 0) {
        throw new CliError(
          `Unknown signal(s): ${unknownKeys.join(', ')}. Valid: ${SIGNAL_KEYS.join(', ')}`,
        );
      }

      const result = await qualifyProspect(userId, id, coerceSignals(parsed));
      if (!result.ok) throw new CliError(result.error);

      out(`Score ${result.result.score}/100 — ${result.result.band}`);
      for (const reason of result.result.reasons.filter((r) => r.points > 0)) {
        out(`  + ${reason.points}  ${reason.label}`);
      }
      if (result.result.unknownSignals.length > 0) {
        out(`  unknown (scored zero): ${result.result.unknownSignals.join(', ')}`);
      }
      return;
    }

    if (command === 'export') {
      const csv = await exportProspectsCsv(userId);
      const target = typeof args.options.out === 'string' ? args.options.out : null;
      if (target) {
        await writeFile(target, csv, 'utf8');
        out(`Wrote ${target}.`);
      } else {
        out(csv);
      }
      return;
    }
  }

  /* ----- campaign ----- */
  if (group === 'campaign') {
    const userId = await resolveUserId(args);

    if (command === 'list') {
      const rows = await listCampaigns(userId);
      table(
        rows.map(({ campaign, memberCount, activeCount, sentCount }) => ({
          id: campaign.id.slice(0, 8),
          name: campaign.name.slice(0, 30),
          status: campaign.status,
          enrolled: memberCount,
          active: activeCount,
          sent: sentCount,
          window: describeWindows({
            windows: campaign.sendingWindows,
            sendDays: campaign.sendDays,
            timeZone: campaign.timezone,
          }).slice(0, 40),
        })),
      );
      return;
    }

    const transitions: Record<string, CampaignStatus> = {
      start: 'RUNNING',
      pause: 'PAUSED',
      resume: 'RUNNING',
      archive: 'ARCHIVED',
    };

    if (command && command in transitions) {
      const id = await resolveCampaignId(userId, required(args, 'id'));
      const result = await setCampaignStatus(userId, id, transitions[command] as CampaignStatus);
      if (!result.ok) throw new CliError(result.error ?? 'Could not change status.');
      out(`Campaign is now ${transitions[command]}.`);
      return;
    }
  }

  /* ----- email ----- */
  if (group === 'email') {
    const userId = await resolveUserId(args);

    if (command === 'queue') {
      const queue = await getReviewQueue(userId, 50);
      table(
        queue.map(({ message, company, contact, prospect }) => ({
          id: message.id.slice(0, 8),
          company: company.name.slice(0, 26),
          to: contact.email.slice(0, 30),
          score: prospect.qualificationScore ?? '—',
          subject: message.subject.slice(0, 34),
        })),
      );
      return;
    }

    if (command === 'preview') {
      const id = await resolveMessageId(userId, required(args, 'id'));
      const record = await getMessage(userId, id);
      if (!record) throw new CliError('Message not found.');

      out(`To:      ${record.message.toEmail}`);
      out(`Status:  ${record.message.status}`);
      out(`Subject: ${record.message.subject}`);
      out('');
      out(record.message.bodyText);
      return;
    }

    if (command === 'approve') {
      const id = await resolveMessageId(userId, required(args, 'id'));
      const record = await getMessage(userId, id);
      if (!record) throw new CliError('Message not found.');

      // Print the content first: approving without seeing it would defeat the
      // purpose of the approval gate.
      out(`To:      ${record.message.toEmail}`);
      out(`Subject: ${record.message.subject}`);
      out('');
      out(record.message.bodyText);
      out('');

      if (!args.options.yes) {
        out('Re-run with --yes to record your approval of the content above.');
        return;
      }

      const result = await approveDraft(userId, id, userId, record.message.contentHash);
      if (!result.ok) throw new CliError(result.error ?? 'Could not approve.');
      out(`Approved (version ${result.approvalVersion}).`);
      return;
    }
  }

  /* ----- suppression ----- */
  if (group === 'suppression') {
    const userId = await resolveUserId(args);

    if (command === 'add') {
      const email = typeof args.options.email === 'string' ? args.options.email : null;
      const domain = typeof args.options.domain === 'string' ? args.options.domain : null;
      if (!email && !domain) throw new CliError('Pass --email or --domain.');

      await addSuppression({
        userId,
        email,
        domain,
        reason: ((args.options.reason as string) ?? 'MANUAL_BLOCK') as SuppressionReason,
        note: 'Added from the CLI.',
        createdBy: userId,
      });
      out(`Suppressed ${email ?? domain}.`);
      return;
    }

    if (command === 'list') {
      const rows = await listSuppressions(userId);
      table(
        rows.map((row) => ({
          target: row.normalizedEmail ?? row.normalizedDomain ?? '',
          scope: row.scope,
          reason: row.reason,
          added: row.createdAt.toISOString().slice(0, 10),
        })),
      );
      return;
    }
  }

  /* ----- discover ----- */
  if (group === 'discover') {
    if (command === 'sources') {
      table(
        listSources().map((source) => ({
          kind: source.kind,
          name: source.name.slice(0, 40),
          basis: source.accessBasis.slice(0, 60),
        })),
      );
      return;
    }

    const userId = await resolveUserId(args);

    if (command === 'list') {
      const rows = await listDiscoverySources(userId);
      table(
        rows.map((row) => ({
          id: row.id.slice(0, 8),
          name: row.name.slice(0, 28),
          kind: row.kind,
          enabled: row.enabled ? 'yes' : 'no',
          last_run: row.lastRunAt ? row.lastRunAt.toISOString().slice(0, 16) : 'never',
        })),
      );
      return;
    }

    if (command === 'add') {
      const kind = required(args, 'kind');
      const csv = (value: string | boolean | undefined): string[] =>
        typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : [];

      const config: Record<string, unknown> = {
        limit: Number(args.options.limit ?? 50),
        minMatchScore: Number(args.options['min-score'] ?? 0),
      };
      if (kind === 'hacker-news') config.keywords = csv(args.options.keywords);
      if (kind === 'github') {
        config.languages = csv(args.options.languages);
        if (typeof args.options.token === 'string') config.token = args.options.token;
      }
      if (kind === 'sec-form-d') config.sicPrefixes = csv(args.options.sic);

      const result = await createDiscoverySource({
        userId,
        kind,
        name: required(args, 'name'),
        config,
      });
      if (!result.ok) throw new CliError(result.error);
      out(`Added source "${result.source.name}" (${result.source.id.slice(0, 8)}).`);
      return;
    }

    if (command === 'run') {
      const sources = await listDiscoverySources(userId);
      const sourceId = await resolveByPrefix(sources, required(args, 'id'), 'source');

      out('Running. This makes real requests to the source API, rate limited politely.');
      const result = await runDiscovery({
        userId,
        sourceId,
        ...(args.options.limit ? { limit: Number(args.options.limit) } : {}),
      });

      out('');
      table([
        {
          status: result.status,
          examined: result.itemsFetched,
          staged: result.candidatesCreated,
          already_known: result.duplicatesSkipped,
          excluded_geo: result.excludedByGeography,
          low_match: result.belowMatchThreshold,
        },
      ]);
      for (const warning of result.warnings) out(`  warning: ${warning}`);
      if (result.error) out(`  error: ${result.error}`);
      out('\nCandidates are staged for review. Nothing has been contacted.');
      return;
    }

    if (command === 'candidates') {
      const result = await listCandidates(
        userId,
        {
          status: ((args.options.status as string) ?? 'NEW') as 'NEW',
          ...(args.options['min-score']
            ? { minMatchScore: Number(args.options['min-score']) }
            : {}),
          ...(typeof args.options.source === 'string' ? { source: args.options.source } : {}),
        },
        1,
        Number(args.options.limit ?? 25),
      );

      table(
        result.items.map((c) => ({
          id: c.id.slice(0, 8),
          company: c.companyName.slice(0, 26),
          match: c.matchScore,
          country: c.country ?? '?',
          contact: c.contactability === 'CONSENT_REQUIRED' ? 'consent!' : (c.country ?? '?'),
          email: c.publishedEmail ? c.publishedEmail.slice(0, 26) : '(none)',
          funding: c.fundingSignals[0]?.slice(0, 20) ?? '',
        })),
      );
      out(`\n${result.total} total.`);
      return;
    }

    if (command === 'promote') {
      const all = await listCandidates(userId, {}, 1, 100);
      const candidateId = await resolveByPrefix(all.items, required(args, 'id'), 'candidate');

      const result = await promoteCandidate({
        userId,
        candidateId,
        ...(typeof args.options.email === 'string' ? { contactEmail: args.options.email } : {}),
        ...(typeof args.options.name === 'string' ? { contactName: args.options.name } : {}),
        ...(typeof args.options.role === 'string' ? { contactRole: args.options.role } : {}),
        acknowledgedConsentRisk: Boolean(args.options['acknowledge-consent']),
      });

      if (!result.ok) throw new CliError(result.error);
      out(`Promoted to prospect ${result.prospectId.slice(0, 8)}. Research it before drafting.`);
      return;
    }

    if (command === 'reject') {
      const all = await listCandidates(userId, {}, 1, 100);
      const candidateId = await resolveByPrefix(all.items, required(args, 'id'), 'candidate');
      const result = await rejectCandidate(
        userId,
        candidateId,
        (args.options.note as string) ?? 'Not a fit.',
      );
      if (!result.ok) throw new CliError(result.error ?? 'Could not reject.');
      out('Rejected.');
      return;
    }

    if (command === 'runs') {
      const rows = await listDiscoveryRuns(userId, 20);
      table(
        rows.map((run) => ({
          started: run.startedAt.toISOString().slice(0, 16),
          kind: run.kind,
          status: run.status,
          examined: run.itemsFetched,
          staged: run.candidatesCreated,
          excluded: run.excludedByGeography,
          error: (run.error ?? '').slice(0, 40),
        })),
      );
      const counts = await getDiscoveryCounts(userId);
      out(`\nAwaiting review: ${counts.new} · promoted: ${counts.promoted} · rejected: ${counts.rejected}`);
      return;
    }
  }

  /* ----- analytics ----- */
  if (group === 'analytics') {
    const userId = await resolveUserId(args);
    const a = await getAnalytics(userId);

    out('Business outcomes');
    table([
      {
        positive_replies: a.outreach.positiveReplies,
        meetings: a.outreach.meetings,
        proposals: a.sales.proposals,
        won: a.sales.won,
        revenue: a.sales.revenue,
      },
    ]);

    out('\nConversion (%)');
    table([
      {
        qualification: a.conversion.qualificationRate,
        delivery: a.conversion.deliveryRate,
        reply: a.conversion.replyRate,
        positive: a.conversion.positiveReplyRate,
        meeting: a.conversion.meetingRate,
        close: a.conversion.closeRate,
      },
    ]);

    out('\nVolume');
    table([
      {
        prospects: a.prospects.total,
        qualified: a.prospects.qualified,
        sent: a.outreach.sent,
        bounced: a.outreach.bounced,
        blocked: a.outreach.blocked,
      },
    ]);

    const perCampaign = await getCampaignPerformance(userId);
    if (perCampaign.length > 0) {
      out('\nBy campaign');
      table(
        perCampaign.map((c) => ({
          name: c.name.slice(0, 30),
          status: c.status,
          sent: c.sent,
          replies: c.replies,
          positive: c.positiveReplies,
          meetings: c.meetings,
          reply_rate: `${c.replyRate}%`,
        })),
      );
    }
    return;
  }

  /* ----- ops ----- */
  if (group === 'ops') {
    const userId = await resolveUserId(args);

    if (command === 'pause-all') {
      const reason = (args.options.reason as string) ?? 'Paused from the CLI.';
      const result = await setGlobalPause(userId, true, reason);
      out(`All sending paused. ${result.campaignsPaused ?? 0} running campaign(s) also paused.`);
      out('Queued messages are stopped too — the worker re-reads this flag per job.');
      return;
    }

    if (command === 'resume-all') {
      await setGlobalPause(userId, false, 'Resumed from the CLI.');
      out('Sending resumed. Restart each campaign you want running.');
      return;
    }

    if (command === 'queue') {
      const stats = await getQueueStats();
      table([stats as unknown as Record<string, string | number | null>]);
      return;
    }

    if (command === 'failed') {
      const snapshot = await getOperationsSnapshot(userId);
      out('Failed jobs');
      table(
        (await listFailedJobs(25)).map((job) => ({
          id: job.id.slice(0, 8),
          kind: job.kind,
          attempts: job.attempts,
          error: (job.lastError ?? '').slice(0, 60),
        })),
      );
      out('\nFailed and blocked messages');
      table(
        [...snapshot.failedMessages, ...snapshot.blockedMessages].map(({ message, contact }) => ({
          id: message.id.slice(0, 8),
          to: contact.email.slice(0, 30),
          status: message.status,
          reason: (message.blockedReason ?? '').slice(0, 50),
        })),
      );
      return;
    }

    if (command === 'retry') {
      if (typeof args.options.message === 'string') {
        const id = await resolveMessageId(userId, args.options.message);
        const result = await retryFailedMessage(userId, id);
        if (!result.ok) throw new CliError(result.error ?? 'Could not retry.');
        out('Message re-queued. It will pass the full preflight again before sending.');
        return;
      }
      if (typeof args.options.job === 'string') {
        const ok = await retryJob(args.options.job);
        out(ok ? 'Job re-queued.' : 'No failed job with that id.');
        return;
      }
      throw new CliError('Pass --message <id> or --job <id>.');
    }

    if (command === 'unstick') {
      const released = await releaseStuckJobs(getEnv().WORKER_VISIBILITY_TIMEOUT_SECONDS);
      out(`Released ${released} stuck job(s).`);
      return;
    }

    if (command === 'export-activities') {
      const csv = await exportActivitiesCsv(userId);
      const target = typeof args.options.out === 'string' ? args.options.out : null;
      if (target) {
        await writeFile(target, csv, 'utf8');
        out(`Wrote ${target}.`);
      } else {
        out(csv);
      }
      return;
    }
  }

  throw new CliError(`Unknown command: ${group} ${command ?? ''}\n\n${HELP}`);
}

/** Accept either a full UUID or a unique short prefix, as printed by `list`. */
async function resolveByPrefix(
  candidates: { id: string }[],
  prefix: string,
  label: string,
): Promise<string> {
  const matches = candidates.filter((row) => row.id.startsWith(prefix));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new CliError(`No ${label} matching "${prefix}".`);
  throw new CliError(`"${prefix}" matches ${matches.length} ${label}s. Use a longer prefix.`);
}

async function resolveCampaignId(userId: string, prefix: string): Promise<string> {
  const rows = await getDb()
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.userId, userId));
  return resolveByPrefix(rows, prefix, 'campaign');
}

async function resolveMessageId(userId: string, prefix: string): Promise<string> {
  const rows = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.userId, userId));
  return resolveByPrefix(rows, prefix, 'message');
}

/* -------------------------------------------------------------------------- */

run(parseArgs(process.argv.slice(2)))
  .then(async () => {
    await closeDb();
  })
  .catch(async (error: unknown) => {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    }
    await closeDb();
    process.exit(1);
  });
