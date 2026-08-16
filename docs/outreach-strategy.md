# Outreach strategy

This document describes what the system is *for*, and the rules it encodes so
that the tool cannot drift into being a spam cannon.

## The pipeline

```
US prospect → qualified → researched → personalised draft → human approval
   → sent → reply → discovery call → proposal → contract → recurring client
```

Every arrow before "sent" is deliberately cheap. The arrow *at* "sent" is
deliberately expensive: it requires an explicit human approval that is
invalidated by any subsequent edit. The system optimises for the quality of the
conversation, not the count of the sends.

## Ideal client profile

Encoded as campaign target criteria, not as hard-coded filters:

* US SaaS / product companies, startups, small engineering teams, agencies
  needing capacity, companies hiring contractors.
* An identifiable technical decision maker.
* An active product with visible engineering signals.
* A plausible ability to pay for professional engineering.
* A technology overlap with the operator's stack.

## Contact priority

`role_category` is ordered: `FOUNDER`, `CO_FOUNDER`, `CTO`, `VP_ENGINEERING`,
`HEAD_OF_ENGINEERING`, `ENGINEERING_MANAGER`, `TECHNICAL_DECISION_MAKER`. The
review queue sorts by this. `OTHER`/`UNKNOWN` contacts are not blocked but are
sorted last and surfaced with a warning, because contacting a random employee
is usually a mistake rather than a strategy.

`contacts.contact_reason` is a required field on the review screen: the
operator must be able to state why *this person*.

## Qualification (deterministic, no inference)

| Signal | Points |
| --- | --- |
| US company | 20 |
| SaaS / software company | 15 |
| Engineering team identified | 10 |
| Currently hiring engineers | 15 |
| Contractor / freelancer signal | 15 |
| Technology match | 10 |
| Identifiable engineering need | 10 |
| Decision maker identified | 5 |
| **Maximum** | **100** |

| Band | Range |
| --- | --- |
| High Priority | 90–100 |
| Strong | 75–89 |
| Potential | 60–74 |
| Weak | 40–59 |
| Poor | 0–39 |

Weights are stored in `settings.qualification_weights` and editable in the UI.

Each signal is tri-state: `YES`, `NO`, `UNKNOWN`. **`UNKNOWN` scores zero and
is recorded as unknown.** The engine never fills a gap with an assumption; a
prospect with mostly unknown signals scores low, which is the correct outcome —
it means "go do the research", not "this company is bad".

## Research

Research is human work. The system's job is to make the ten questions of §15
easy to answer and to keep each answer next to its source:

1. What does the company do?
2. What product do they sell?
3. Who are their customers?
4. What engineering signals exist?
5. Are they hiring?
6. What technologies are publicly visible?
7. What potential problem could I help with?
8. Why am I relevant?
9. Why contact this person?
10. What is my reason for reaching out *now*?

Any research field may carry one or more source URLs. A field without a source
renders as unverified in the review screen. The system will not present an
unsourced claim as fact, and there is no code path that generates research text.

## Personalisation

Personalisation comes from five operator-entered fields:

* `specific_observation` — something concretely true about this company
* `engineering_signal` — the observable engineering fact
* `pain_point` — the problem being addressed
* `why_relevant` — why the operator specifically
* `specific_offer` — the concrete thing on offer

These render into templates. If a template references a variable the operator
has not filled in, rendering **fails loudly** and the draft cannot be approved.
No default text, no placeholder, no invention.

## Email structure

**Initial:** subject → greeting → relevant observation → why contacting them →
relevant capability → potential value → simple CTA → signature.

**Follow-up #1:** short, references the initial email, adds one new thing. Not
a resend.

**Follow-up #2:** short, one different angle.

**Final:** polite close, explicitly ends the thread. No manufactured urgency,
no false scarcity, no "just bumping this to the top of your inbox" theatre, no
fake re: subject lines.

The default sequence is Day 0 / +4 / +9 / +16, stored as `campaign_steps` rows,
not constants.

## Volume

Default limits ship deliberately low: 20/day, 5/hour, 2 per recipient domain
per day, with a 90–600 second inter-send delay. These are conservative for
cold outreach from a single sender and protect both deliverability and the
operator's domain reputation. They are configurable, and the system will not
help raise them beyond what a provider permits.

## Stop conditions

A sequence stops immediately and server-side on: reply received, meeting
booked, `NOT_INTERESTED`, `DO_NOT_CONTACT`, bounce, suppression, campaign
pause, manual removal. The stop is enforced in the send preflight, so a stop
that lands after a job is queued still prevents the send.

## What the system will not do

* Send without a current human approval.
* Send to anyone on the suppression list, ever.
* Continue a sequence after a reply.
* Invent facts about a company or a person.
* Scrape sites, bypass CAPTCHAs, evade rate limits, or work around anti-bot
  controls.
* Provide any mechanism to evade spam filtering or hide sender identity.
* Automatically optimise campaigns without a human reading the result.

## Measuring the right thing

Vanity metrics (sends, opens) are recorded but demoted in the dashboard. The
primary metrics are: **positive replies, meetings booked, proposals sent,
contracts won, revenue.** A campaign that sends 200 emails and books zero
meetings is a failed campaign, and the analytics view is arranged to make that
obvious rather than to flatter volume.
