/**
 * Recording-consent rules by jurisdiction.
 *
 * WHY A REGISTRY AND NOT A BOOLEAN. Whether a call may be recorded is not one
 * question but two: does this tenant hold a consent basis, and does the law
 * where the other party is sitting allow recording on that basis. A system that
 * only asks the first will happily record a two-party-consent state on a
 * one-party basis, which is lawful nowhere and is not detectable afterwards
 * from anything stored.
 *
 * THIS IS NOT LEGAL ADVICE AND THE FILE SHOULD NOT PRETEND TO BE. It encodes a
 * small, conservative, checkable rule per jurisdiction, and defaults to the
 * STRICTER treatment when a jurisdiction is unknown — see `ruleFor`. A tenant
 * operating somewhere not listed adds it deliberately rather than discovering
 * that silence meant permission.
 */

export type ConsentRule =
  /** One party to the call may consent on behalf of the recording. */
  | 'one_party'
  /** EVERY party must have consented before recording may start. */
  | 'all_party'
  /** Recording is not permitted on any basis this application can obtain. */
  | 'prohibited';

export interface JurisdictionPolicy {
  /** ISO-ish code. Region-qualified where the rule is sub-national. */
  code: string;
  label: string;
  rule: ConsentRule;
  /** The wording a rep is shown when this rule blocks a recording. */
  blockReason: string;
  /** Why this rule, in the operator's terms. */
  basis: string;
}

/**
 * The registry.
 *
 * Deliberately short. Each entry is a rule somebody has to be able to defend,
 * and a long list nobody has reviewed is worse than a short one that is
 * obviously incomplete — the short list makes the gaps visible, and the gaps
 * default to strict.
 */
export const JURISDICTION_POLICIES: JurisdictionPolicy[] = [
  {
    code: 'US-CA',
    label: 'California, United States',
    rule: 'all_party',
    blockReason:
      'California requires every party to consent before a call is recorded. Ask for and capture consent from the prospect on the call, then record.',
    basis: 'Cal. Penal Code §632 treats confidential communications as all-party consent.',
  },
  {
    code: 'US-WA',
    label: 'Washington, United States',
    rule: 'all_party',
    blockReason:
      'Washington requires every party to consent before a call is recorded. Capture the prospect’s consent first.',
    basis: 'Wash. Rev. Code §9.73.030 is an all-party consent statute.',
  },
  {
    code: 'US-NY',
    label: 'New York, United States',
    rule: 'one_party',
    blockReason: '',
    basis: 'New York is a one-party consent jurisdiction; the rep on the call may consent.',
  },
  {
    code: 'US-TX',
    label: 'Texas, United States',
    rule: 'one_party',
    blockReason: '',
    basis: 'Texas is a one-party consent jurisdiction.',
  },
  {
    code: 'GB',
    label: 'United Kingdom',
    rule: 'all_party',
    blockReason:
      'UK guidance requires the other party to be informed and to have agreed before a business call is recorded. Play the notice and capture agreement first.',
    basis:
      'Recording for business purposes requires notification and a lawful basis; treated as all-party here because notification alone is not consent.',
  },
];

/**
 * The rule for a jurisdiction, defaulting STRICT.
 *
 * AN UNKNOWN JURISDICTION IS TREATED AS ALL-PARTY, not as one-party and not as
 * prohibited. Not one-party, because "we had not got round to adding that state"
 * must never be the reason a call was recorded unlawfully. Not prohibited,
 * because that would stop a tenant working the moment they take a call from
 * somewhere unlisted, and a control that halts ordinary business gets switched
 * off. All-party is the strictest rule that still leaves a lawful path: capture
 * the prospect's consent and proceed.
 */
export function ruleFor(code: string | null | undefined): JurisdictionPolicy {
  const found = code
    ? JURISDICTION_POLICIES.find((policy) => policy.code === code.toUpperCase())
    : undefined;

  if (found) {
    return found;
  }

  return {
    code: code ? code.toUpperCase() : 'UNKNOWN',
    label: code ? `${code.toUpperCase()} (not in the registry)` : 'Unknown jurisdiction',
    rule: 'all_party',
    blockReason:
      'We do not hold a recording rule for this jurisdiction, so the strictest one applies: every party must consent. Capture the prospect’s consent on the call before recording.',
    basis:
      'Default for an unlisted jurisdiction. Strict by design — an unreviewed gap must not read as permission.',
  };
}

/** Every registered code, for the pre-call picker and for tests. */
export function allJurisdictionCodes(): string[] {
  return JURISDICTION_POLICIES.map((policy) => policy.code);
}
