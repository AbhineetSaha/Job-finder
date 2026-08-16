# Compliance controls

> **This system is not "legally compliant" and this document does not say that
> it is.** These are technical controls that support responsible commercial
> outreach. The operator remains responsible for complying with applicable
> laws, regulations, and the terms of service of every provider and platform
> used. Several matters below require professional legal advice.
>
> This document reflects the author's understanding of the law as of the build
> date and is not legal advice. Verify current requirements with counsel before
> running real outreach.

## Scope

Business-to-business cold email sent from a US-based sole operator to
recipients at US companies.

## CAN-SPAM Act (15 U.S.C. §§ 7701–7713; FTC Rule 16 C.F.R. Part 316)

CAN-SPAM applies to "commercial electronic mail messages" — including B2B
email. It has no exemption for business recipients and no opt-in requirement;
it is an opt-*out* regime with specific mandatory elements.

| Requirement | Technical control in this system |
| --- | --- |
| No false or misleading header information (From, To, Reply-To, routing) | `EMAIL_FROM` / `EMAIL_REPLY_TO` are configuration, validated as well-formed addresses; the system provides no aliasing, spoofing, or rotation feature |
| No deceptive subject lines | Subjects are operator-written and reviewed; no `Re:`/`Fwd:` prefixing feature exists |
| Identify the message as an advertisement | Configurable disclosure line in the footer block (`settings.unsubscribe_footer`); on by default |
| Valid physical postal address | `settings.postal_address` is **required** before `EMAIL_MODE=production` will start sending; the worker blocks with `MISSING_POSTAL_ADDRESS` if it is empty |
| Clear and conspicuous opt-out mechanism | Every outbound message gets an unsubscribe link with a per-contact unguessable token, plus a `List-Unsubscribe` header (and `List-Unsubscribe-Post` for one-click) |
| Opt-out honoured within 10 business days | Honoured **immediately and synchronously**: the unsubscribe endpoint writes the suppression row and stops the active sequence in one transaction |
| Opt-out mechanism must work for at least 30 days after sending | Tokens do not expire; the suppression they create is permanent |
| No transfer of an opt-out address | Suppression rows are never deleted by the retention job and survive prospect deletion (see below) |
| Monitor what others do on your behalf | Single-operator system; every send is attributable in `audit_logs` |

Statutory penalties are per-message and substantial. The conservative default
limits exist partly for this reason.

## Opt-out durability

Deleting a prospect does **not** delete their suppression. `src/services/
deletion.ts` promotes any live suppression to a standalone row keyed on the
normalised email/domain before cascading the delete. Without this, "clean up
old prospects" would silently re-enable contacting people who unsubscribed.
Covered by `tests/integration/deletion-preserves-suppression.test.ts`.

## State privacy law

US state comprehensive privacy statutes (California's CCPA as amended by CPRA,
and the similar statutes enacted in Virginia, Colorado, Connecticut, Utah and a
growing list of other states) can reach business contact information. Key
points the operator should raise with counsel:

* **B2B exemptions are narrow and shrinking.** California's temporary exemption
  for business-to-business contact data expired; business contacts are now
  generally treated as consumers under the CCPA/CPRA.
* **Applicability thresholds.** Most of these statutes apply above revenue or
  data-volume thresholds that a sole operator is unlikely to meet. *Unlikely
  is not never*, and thresholds change. Confirm rather than assume.
* **Rights that may apply if in scope:** notice at collection, access,
  deletion, correction, and opt-out of "sale"/"sharing". Buying or exchanging
  prospect lists can constitute a "sale" even without money changing hands.

Controls provided: a source and `source_url` are recorded on every prospect so
provenance is auditable; full export and hard-delete of any prospect are
available from the UI and CLI; retention windows are configurable per data
category.

## Other regimes

* **GDPR / UK GDPR / PECR** — out of scope by design: the ICP is US-only and
  `country` defaults to `US`. If the operator ever contacts EU/UK recipients,
  the analysis is materially different (lawful basis, legitimate-interest
  assessment, and for the UK a stricter e-privacy rule on unsolicited email)
  and **requires legal advice before the first send**. The system does not
  block non-US prospects, but qualification awards zero points for a non-US
  company and the UI flags them.
* **CASL (Canada)** — consent-based, not opt-out, with significant penalties.
  Do not treat a Canadian recipient as equivalent to a US one.
* **Provider terms of service** — every email provider has its own cold-outreach
  policy, and some prohibit it outright on shared infrastructure. Read the
  policy before configuring a provider. The system contains no feature to evade
  provider limits or filtering.

## What is deliberately absent

No open-tracking pixel, no link-wrapping click tracker, no seed-list warming
automation, no domain or IP rotation, no subject-line obfuscation, no
unsubscribe-link hiding, no "unsubscribe requires login" pattern. Each of those
is either a deceptive practice, a provider-policy violation, or an anti-spam
evasion, and the brief prohibits building them.

## Operator responsibilities the software cannot discharge

1. Confirming that the sending domain, SPF, DKIM and DMARC are correctly
   configured for the `EMAIL_FROM` domain.
2. Reading and complying with the chosen provider's acceptable-use policy.
3. Ensuring the postal address configured is a genuine valid physical address.
4. Ensuring the substantive claims in email content are truthful.
5. Deciding whether any state privacy statute applies to their business.
6. Responding to individual rights requests within statutory deadlines.
7. Keeping prospect data lawfully sourced — the system records provenance but
   cannot verify it.

**Flagged for professional legal advice:** applicability of state privacy
statutes to the operator's specific business; whether any prospect list source
constitutes a "sale" of personal information; any outreach to non-US
recipients; contract and liability terms in the proposals the pipeline
produces.
