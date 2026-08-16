# Automated prospect discovery

Discovery finds companies. It does not decide anything.

Everything a source returns lands in a staging table for you to review.
Discovery **cannot** create a prospect, enrol anyone in a campaign, or send
anything. Promoting a candidate is an explicit act, and the resulting prospect
starts at `DISCOVERED` — it still has to be researched, drafted, and approved
like any other.

This is a deliberate change of scope from the original build, which excluded
automated sourcing (brief §11, §64). The `ProspectSource` interface was
designed for it; this document records what was added and, more importantly,
what was ruled out.

---

## What it looks for

Per the request: companies **outside India**, generally **funded startups**,
with a **technology match** against your profile.

| Requirement | How it is implemented |
| --- | --- |
| Outside India | `DEFAULT_GEOGRAPHY_POLICY` excludes `IN`. Configurable, including an allowlist. |
| Funded startups | Funding signals detected deterministically; SEC Form D is a source of nothing *but* recently funded companies. |
| Matches your profile | Deterministic technology overlap against `user_profiles.skills`, scored 0–100 with a stated reason for every point. |

## The sources

All three are free and need no paid data vendor. A token is optional for one.

### 1. Hacker News — "Who is hiring?"

**Access basis:** the public, documented, no-auth Algolia HN Search API.

The monthly *Ask HN: Who is hiring?* thread is the single best free source for
this use case, because the posts are written by companies **asking to be
contacted**, usually with their stack, their location, and an email address
they chose to publish.

Config: `keywords` (all must appear), `monthsBack`, `limit`, `minMatchScore`.

```bash
npm run outreach -- discover add --kind hacker-news --name "Postgres startups" \
  --keywords "postgres,remote" --min-score 40
```

### 2. GitHub — organisations by technology

**Access basis:** the official GitHub REST API, within its documented rate
limits. Reads public organisation profile data only.

The strongest source for *technology* matching, because it finds companies by
the language and topics of code they actually ship, not by what a marketing
page claims.

A token is optional but strongly recommended — unauthenticated search is
throttled to roughly 10 requests a minute.

```bash
npm run outreach -- discover add --kind github --name "TS/Java orgs" \
  --languages "TypeScript,Java" --token ghp_xxx
```

### 3. SEC Form D — recently funded US companies

**Access basis:** US government public-domain EDGAR data, retrieved with an
identifying User-Agent well under the SEC's fair-access limit.

Form D is the notice filed for an exempt securities offering, which in practice
means *this company just closed a funding round*. It is the most direct public
funding signal that exists, and it is free.

Two honest limitations:

- **US only.** It cannot find funded startups elsewhere.
- **No contact details.** Filings carry no email. This source produces company
  leads with a funding signal; finding the right person is research you do.

The default `sicPrefixes: ["73"]` filter matters — without it, Form D is
dominated by investment funds and real-estate partnerships.

```bash
npm run outreach -- discover add --kind sec-form-d --name "Funded US software" --sic 73
```

## Geography and the legal footing

This is the part worth reading carefully.

Countries are classified into a **contactability tier**, which is a legal
posture, not a preference:

| Tier | Countries | Meaning |
| --- | --- | --- |
| `OPT_OUT_REGIME` | US | CAN-SPAM: cold email is lawful subject to identification, postal address, and a working unsubscribe. This is what the rest of the system is built for. |
| `CONSENT_REQUIRED` | EEA, UK, Switzerland, Canada, Australia, New Zealand | GDPR/PECR and CASL are consent-based. Cold email generally requires a lawful basis or prior consent. |
| `EXCLUDED` | India (default) | Dropped at discovery. |
| `UNKNOWN` | Everything else | Staged for you to resolve manually. |

A `CONSENT_REQUIRED` candidate **can** be discovered — knowing a company exists
is not the same as emailing it — but promotion is blocked until you explicitly
tick a box confirming you have a lawful basis. That box exists so the decision
is a decision, not a click-through.

> **Widening beyond the US is a legal change, not a configuration change.**
> The templates, the footer, and the unsubscribe flow are built for an opt-out
> regime. Before emailing anyone in the EEA, UK, or Canada, get advice. This
> is flagged in `docs/compliance.md` and the system will keep flagging it.

Country inference is deliberately conservative: explicit country names, US
state codes and names, and unambiguous major cities. Anything it is unsure of
returns `null` and surfaces as "country unknown" rather than a confident wrong
answer.

## Match scoring

Deterministic and explainable — every point traces to a stated reason.

| Signal | Points |
| --- | --- |
| Technology overlap with your skills | 10 each, capped at 50 |
| Funding signal detected | 20 |
| Hiring signal detected | 20 |
| Industry match against your profile | 10 |

Technology matching canonicalises aliases, so `postgres`, `PostgreSQL` and
`psql` are one skill. Two-letter aliases (`go`, `js`, `ts`) are matched as
*exact declared* technologies — a GitHub `language: "Go"` field counts — but
are never mined out of prose, because "we go fast" is not a Go shop.

Set `minMatchScore` per source to keep the staging queue useful.

## What this deliberately does not do

Every item here was a live option and was ruled out.

**No email guessing.** There is no function anywhere in this codebase that
permutes `first.last@domain`. Only addresses a company or person **published
themselves** are captured. Guessed addresses bounce; enough bounces get your
sending domain blocked. If a candidate has no published address, you find one
or you skip them.

**No scraping of platforms that prohibit it.** No LinkedIn, no scraping behind
a login, no bypassing a CAPTCHA, no proxy rotation, no cookie replay, no
User-Agent spoofing. If a source needs any of that, this system does not
support it.

**No robots.txt violations.** Any direct HTML fetch consults robots.txt first,
and a robots.txt that cannot be read is treated as a disallow, not as
permission.

**No bursts.** One request per host per ~1.1 seconds, `Retry-After` obeyed,
bounded retries with backoff, response size capped, and no retry on a 4xx.

**No auto-promotion.** There is no setting that turns discovered candidates
into prospects automatically, and adding one would defeat the purpose of the
review queue.

## Operating it

```bash
npm run outreach -- discover sources          # what adapters exist
npm run outreach -- discover add --kind hacker-news --name "…" --keywords "postgres"
npm run outreach -- discover run --id <source>
npm run outreach -- discover candidates --min-score 50
npm run outreach -- discover promote --id <candidate> --email cto@acme.io --name "Dana W" --role CTO
npm run outreach -- discover reject --id <candidate> --note "Too large"
npm run outreach -- discover runs
```

Or use the **Discovery** page, which does the same thing and shows why each
candidate matched.

Runs triggered from the UI go through the worker, deduplicated to one run per
source per hour, so a double click does not double the requests made to
someone else's API.

## Suggested weekly rhythm

1. Run the HN source after the monthly thread appears (first working day of the
   month), and the GitHub source weekly.
2. Filter the queue to `min match 50` and `has published email`.
3. Promote five to ten. Reject the rest with a reason — the reasons are how you
   learn what your sources are actually good for.
4. Research the promoted ones properly before drafting anything.

Discovery makes step 1 cheap. It does not make steps 3 and 4 optional, and the
quality of your outreach still comes from those.

## Known limitations

1. **Live API calls were not verifiable in the build environment** — outbound
   access to `hn.algolia.com`, `api.github.com` and `sec.gov` was blocked by
   egress policy. Adapters are written against documented API contracts and
   their parsing is tested against recorded fixtures, but the first real run
   against each provider should be treated as a smoke test. Run with a small
   `--limit` first.
2. **HN post parsing is best-effort.** The `Company | Location | Role` format
   is a convention, not a schema. Posts that do not follow it are skipped
   rather than guessed at, so recall is imperfect by design.
3. **Form D gives no contacts**, and most Form D filers are not software
   companies — hence the SIC filter.
4. **GitHub organisations often have no public email**, so most GitHub
   candidates need you to find a contact.
5. **Country inference will return unknown fairly often.** That is the intended
   failure mode.
6. **No paid enrichment providers** (Crunchbase, Apollo, Clearbit, PDL). The
   `ProspectSource` interface accommodates them; none is implemented, because
   none was available to test against.
