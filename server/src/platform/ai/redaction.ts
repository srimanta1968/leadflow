/**
 * Redaction of prompt inputs, applied before anything leaves the process.
 *
 * WHY REDACT AT ALL when the model provider is under contract. Because the
 * provider is not the only reader: a prompt is logged by the gateway, cached,
 * replayed during an incident, and shown to whoever debugs a bad completion. A
 * contact point that never enters the prompt cannot leak from any of those, and
 * the agents in this system do not need one — they draft a message ABOUT a
 * person, and the address is attached when a human releases it.
 *
 * REPLACED WITH A TYPED PLACEHOLDER, NOT DELETED. `{{email}}` tells the model
 * there was an address, which keeps the sentence grammatical; deleting the span
 * produces prose the model completes in strange ways, and that is how a
 * redaction ends up being reverted by whoever finds the output odd.
 *
 * WHAT THIS IS NOT. It is not a claim that every identifier is caught — a name
 * is personal data and is not detectable by pattern. The claim is narrower and
 * checkable: the CONTACT POINTS and account identifiers below do not reach the
 * provider, and every completion records which rules fired.
 */

export interface RedactionRule {
  /** Stable key, recorded in the ledger. */
  key: string;
  pattern: RegExp;
  /** What replaces a match. */
  placeholder: string;
  why: string;
}

/**
 * The rules, in the order they run.
 *
 * ORDER MATTERS, TWICE OVER, and both orderings were found by a test rather than
 * reasoned about in advance:
 *
 *  - Email runs FIRST because an address can contain digit runs that a later
 *    rule would mask, leaving a fragment that no longer matches the email
 *    pattern and survives as a partial address.
 *  - Payment card runs BEFORE phone. A sixteen-digit card matches the phone
 *    pattern perfectly well, so with phone first every card is masked as
 *    `{{phone}}`. Nothing leaks either way — but the ledger then records that a
 *    phone number was removed, and "was a card number in that prompt" becomes
 *    unanswerable. The narrower rule goes first.
 */
export const REDACTION_RULES: RedactionRule[] = [
  {
    key: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    placeholder: '{{email}}',
    why: 'A contact point. The agent drafts the message; a human attaches the address.',
  },
  {
    key: 'payment_card',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    placeholder: '{{payment_card}}',
    why: 'Never has any business in a prompt, and is the one span whose leak is immediately exploitable. Runs before phone, which would otherwise swallow it.',
  },
  {
    key: 'phone',
    // Deliberately permissive about separators and optional country code, and
    // deliberately requiring at least nine digits: seven-digit runs are dates,
    // order numbers and prices far more often than they are phone numbers, and a
    // rule that masks those makes the prompt unreadable.
    pattern: /\+?\d[\d\s().-]{8,}\d/g,
    placeholder: '{{phone}}',
    why: 'A contact point, same reasoning as email.',
  },
  {
    key: 'bearer_token',
    // Credentials get pasted into free-text notes more often than anyone admits,
    // and a note is exactly the kind of field an agent is asked to summarise.
    pattern: /\b(?:Bearer\s+|sk_live_|sk_test_|pk_live_|pk_test_|ghp_)[A-Za-z0-9._-]{8,}/g,
    placeholder: '{{credential}}',
    why: 'A credential pasted into an operator note must not be replayed to a model provider.',
  },
];

/** What one rule removed. Counts only — never the removed values. */
export interface RedactionHit {
  rule: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  /** Rules that fired, with how many spans each removed. */
  applied: RedactionHit[];
  /** Total spans removed, across all rules. */
  spanCount: number;
}

/**
 * Redact one string.
 *
 * Returns the counts alongside the text because the ledger records WHICH RULES
 * FIRED. A boolean "redaction ran" is worth almost nothing after the fact: it
 * cannot distinguish a prompt that was clean from one where the rules were
 * misconfigured and matched nothing.
 */
export function redact(text: string): RedactionResult {
  const applied: RedactionHit[] = [];
  let current = text;

  for (const rule of REDACTION_RULES) {
    // A fresh RegExp per call: the module-level literals carry /g, and a shared
    // /g regex keeps `lastIndex` between calls, so the second string redacted
    // would be scanned from wherever the first one stopped.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    const matches = current.match(pattern);
    if (!matches || matches.length === 0) {
      continue;
    }
    applied.push({ rule: rule.key, count: matches.length });
    current = current.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.placeholder);
  }

  return {
    text: current,
    applied,
    spanCount: applied.reduce((total, hit) => total + hit.count, 0),
  };
}

/**
 * Redact every value in a slot map.
 *
 * Slot values are where personal data actually enters a prompt — the template
 * body is approved copy and contains none — so this is the function the gateway
 * calls, and `redact` above is its single-string primitive.
 */
export function redactSlots(slots: Record<string, string>): {
  slots: Record<string, string>;
  applied: RedactionHit[];
  spanCount: number;
} {
  const out: Record<string, string> = {};
  const totals = new Map<string, number>();

  for (const [name, value] of Object.entries(slots)) {
    const result = redact(value);
    out[name] = result.text;
    for (const hit of result.applied) {
      totals.set(hit.rule, (totals.get(hit.rule) ?? 0) + hit.count);
    }
  }

  const applied = [...totals.entries()].map(([rule, count]) => ({ rule, count }));
  return {
    slots: out,
    applied,
    spanCount: applied.reduce((total, hit) => total + hit.count, 0),
  };
}
