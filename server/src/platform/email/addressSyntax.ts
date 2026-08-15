import { domainToASCII } from 'url';

/**
 * Stage one of address verification: is this a well-formed address at all, and
 * what kind of address is it?
 *
 * PURE, SYNCHRONOUS, NO NETWORK. Everything here is decidable from the string
 * itself, and separating it from the DNS and SMTP stages is what makes the
 * expensive stages skippable: roughly a fifth of the addresses typed into a
 * capture form are rejected here, and none of those should cost a DNS query.
 *
 * NOT A REGEX. The one-line pattern this replaces — /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
 * which still lives in authValidators.ts and validation.ts and is deliberately
 * left there — accepts `a@-.--`, `a@b..c` and a 400-character local part, and
 * rejects nothing anybody actually mistypes. The failures that matter are
 * structural (a domain label that starts with a hyphen, a doubled dot, an
 * address over the 254-octet SMTP path limit), and structure is what a parser
 * checks and a pattern approximates.
 *
 * DELIBERATELY NARROWER THAN RFC 5322. That grammar permits comments,
 * folding whitespace and source routes, none of which survive contact with a
 * real mail submission API, and accepting them here would only move the
 * rejection to SendGrid where the reason is a 400 body nobody reads. What is
 * accepted is RFC 5321's dot-atom plus the quoted-string form, which is what
 * every mail system in production actually carries.
 */

export type SyntaxCode =
  | 'OK'
  | 'EMPTY'
  | 'NO_AT_SIGN'
  | 'LOCAL_PART_EMPTY'
  | 'LOCAL_PART_TOO_LONG'
  | 'LOCAL_PART_INVALID'
  | 'DOMAIN_EMPTY'
  | 'DOMAIN_INVALID'
  | 'DOMAIN_LABEL_INVALID'
  | 'DOMAIN_NOT_FQDN'
  | 'IP_LITERAL_DOMAIN'
  | 'ADDRESS_TOO_LONG';

export interface SyntaxResult {
  ok: boolean;
  code: SyntaxCode;
  /** A sentence a person can act on. Empty when `ok`. */
  reason: string;
  /** Normalised, ASCII, lowercase-domain. Empty when the parse failed. */
  address: string;
  local: string;
  domain: string;
}

/** RFC 5321 §4.5.3.1: 64 octets of local part, 254 of forward path. */
const MAX_LOCAL = 64;
const MAX_ADDRESS = 254;
const MAX_LABEL = 63;

/** RFC 5322 atext, the characters a dot-atom local part may contain. */
const ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
/** LDH: letters, digits, hyphen — never at the ends. */
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * The mailbox names that belong to a function rather than a person.
 *
 * NOT INVALID, and this list never blocks a send on its own. It changes what a
 * screen should say: "sales@ is a shared inbox — a personal address gets a
 * reply" is useful advice on a lead form and wrong advice on a support ticket.
 * The caller decides; this only reports.
 */
const ROLE_LOCAL_PARTS = new Set([
  'abuse', 'admin', 'administrator', 'billing', 'careers', 'compliance', 'contact',
  'customerservice', 'enquiries', 'enquiry', 'finance', 'help', 'hello', 'hostmaster',
  'hr', 'info', 'inquiries', 'it', 'jobs', 'legal', 'mail', 'marketing', 'news',
  'noc', 'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'notifications',
  'office', 'orders', 'postmaster', 'privacy', 'recruitment', 'root', 'sales',
  'security', 'service', 'support', 'team', 'webmaster',
]);

/**
 * Throwaway-inbox providers.
 *
 * A STARTING SET, EXTENSIBLE BY DEPLOYMENT (EMAIL_DISPOSABLE_DOMAINS). A
 * hard-coded list of a few thousand domains would go stale in the repository
 * and still miss the one a given tenant is being signed up from; a short list
 * of the providers that appear constantly, plus a way to add to it, is the
 * honest version. Like a role address this reports rather than blocks — a
 * disposable address is a real, reachable mailbox, and whether that is
 * acceptable is a business rule, not a deliverability fact.
 */
const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', 'dispostable.com', 'emailondeck.com', 'fakeinbox.com',
  'getairmail.com', 'getnada.com', 'guerrillamail.com', 'inboxbear.com',
  'mailcatch.com', 'maildrop.cc', 'mailinator.com', 'mailnesia.com', 'mintemail.com',
  'mohmal.com', 'moakt.com', 'sharklasers.com', 'spam4.me', 'spamgourmet.com',
  'temp-mail.org', 'tempmail.com', 'tempr.email', 'throwawaymail.com',
  'trashmail.com', 'yopmail.com',
]);

/**
 * The domains people mistype, and the only ones a suggestion is offered for.
 *
 * SUGGESTED, NEVER SUBSTITUTED. `ada@gmial.com` is a syntactically perfect
 * address at a domain that exists and takes mail, so no later stage will ever
 * catch it — a suggestion at the point of typing is the only thing that will.
 * Correcting it silently would be worse than saying nothing: it would send a
 * password reset to an address the person did not enter.
 */
const COMMON_DOMAINS = [
  'aol.com', 'comcast.net', 'gmail.com', 'googlemail.com', 'hotmail.com',
  'hotmail.co.uk', 'icloud.com', 'live.com', 'mac.com', 'me.com', 'msn.com',
  'outlook.com', 'proton.me', 'protonmail.com', 'yahoo.com', 'yahoo.co.uk',
  'ymail.com',
];

/**
 * The domains that are guaranteed never to receive mail.
 *
 * RFC 2606 AND RFC 6761 RESERVE THESE, which is what makes this different from
 * every other list in this file: it is not a heuristic. `example.com` is
 * reserved by the IETF precisely so it can appear in documentation without
 * reaching anybody, and `.test`, `.invalid` and `.localhost` are reserved so
 * they can never be delegated. An address at one of them is undeliverable as a
 * matter of standard, not of judgement — and they arrive constantly, because
 * `test@example.com` is what every developer, demo script and half-finished
 * import file puts in an email field.
 *
 * `.local` is included though it is mDNS rather than RFC 2606: it resolves only
 * on a link-local network, so mail to it leaves the building and vanishes.
 */
const RESERVED_DOMAINS = new Set([
  'example.com', 'example.net', 'example.org', 'example.edu', 'localhost',
]);
const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local']);

/**
 * Local parts that are placeholders rather than people.
 *
 * NOT UNDELIVERABLE, and that distinction is why these get their own verdict
 * rather than being folded into the reserved list. `test@acme.com` may well be
 * a real mailbox somebody reads; what it is not is a person a sales sequence
 * should be started against, and it is overwhelmingly the residue of a form
 * being tried out. So this reports "placeholder" and the send gate decides —
 * blocked by default because the cost of not emailing a real `test@` is a
 * message nobody was waiting for, and the cost of emailing every placeholder
 * in a 5,000-row import is a deliverability incident.
 */
const PLACEHOLDER_LOCAL_PARTS = new Set([
  'a', 'aa', 'aaa', 'abc', 'asd', 'asdf', 'asdfasdf', 'demo', 'dummy', 'example',
  'fake', 'foo', 'foobar', 'bar', 'baz', 'nobody', 'none', 'placeholder', 'qa',
  'qwerty', 'sample', 'test', 'test1', 'test123', 'testing', 'testuser', 'tester',
  'trial', 'user', 'x', 'xx', 'xxx', 'yourname', 'youremail', 'zzz',
]);

/** Does the string carry anything SMTP cannot put on the wire? */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Optimal string alignment distance, capped — full Damerau is not worth it here. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) rows.push([i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      // Transposition — `gmial`/`gmail` is one swap, and swaps are the single
      // most common typing error, so scoring them as two edits loses the case
      // this exists for.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + cost);
      }
    }
  }
  return rows[a.length][b.length];
}

function fail(code: SyntaxCode, reason: string): SyntaxResult {
  return { ok: false, code, reason, address: '', local: '', domain: '' };
}

/**
 * Parse and normalise one address.
 *
 * THE LOCAL PART KEEPS ITS CASE, the domain does not. Domains are
 * case-insensitive by DNS; local parts are case-SENSITIVE by RFC 5321 §2.4 and
 * only convention makes them otherwise. Lower-casing `Ada.Lovelace@` is
 * usually harmless and occasionally delivers mail to the wrong mailbox on the
 * handful of systems that honour the distinction, so this does not do it —
 * callers that need a case-insensitive key (the users table does) lower-case
 * for that purpose themselves, which is a different decision from rewriting
 * the address being sent to.
 */
export function parseAddress(raw: string): SyntaxResult {
  if (typeof raw !== 'string') return fail('EMPTY', 'No address was supplied.');

  // `Ada Lovelace <ada@company.com>` is what a paste from a mail client gives
  // you, and rejecting it teaches the user nothing.
  let value = raw.trim();
  const angled = /<([^<>]*)>\s*$/.exec(value);
  if (angled) value = angled[1].trim();

  if (value === '') return fail('EMPTY', 'No address was supplied.');
  if (/\s/.test(value) || hasControlCharacter(value)) {
    return fail('LOCAL_PART_INVALID', 'An email address cannot contain spaces or control characters.');
  }

  const at = value.lastIndexOf('@');
  if (at === -1) return fail('NO_AT_SIGN', 'An email address needs an @ sign, as in name@company.com.');

  const local = value.slice(0, at);
  const domainRaw = value.slice(at + 1);

  if (local === '') return fail('LOCAL_PART_EMPTY', 'There is nothing before the @ sign.');
  if (local.length > MAX_LOCAL) {
    return fail('LOCAL_PART_TOO_LONG', `The part before the @ is ${local.length} characters; mail systems accept at most ${MAX_LOCAL}.`);
  }

  // The quoted form ("very.unusual@name"@example.com) is legal and rare. It is
  // accepted rather than rejected because rejecting a valid address is the
  // worse error, but nothing inside the quotes is second-guessed beyond the
  // characters SMTP itself cannot carry.
  const quoted = local.startsWith('"') && local.endsWith('"') && local.length >= 2;
  if (!quoted) {
    if (local.startsWith('.') || local.endsWith('.')) {
      return fail('LOCAL_PART_INVALID', 'The part before the @ cannot start or end with a dot.');
    }
    if (local.includes('..')) {
      return fail('LOCAL_PART_INVALID', 'The part before the @ contains two dots in a row.');
    }
    for (const atom of local.split('.')) {
      if (atom === '' || !ATEXT.test(atom)) {
        return fail('LOCAL_PART_INVALID', `"${local}" is not a usable mailbox name — it contains a character mail systems will not accept.`);
      }
    }
  }

  if (domainRaw === '') return fail('DOMAIN_EMPTY', 'There is nothing after the @ sign.');
  if (domainRaw.startsWith('[')) {
    /* [192.0.2.1] is valid RFC 5321 and undeliverable in practice: no provider
       will relay to a bare IP, and every one of these seen in the wild has been
       a paste error or an injection attempt. */
    return fail('IP_LITERAL_DOMAIN', 'An address at a bare IP address cannot be delivered to. Use the domain name instead.');
  }

  /* IDN → punycode BEFORE any structural check, because the length and label
     rules are defined on the ASCII form: münchen.de is 10 characters and
     xn--mnchen-3ya.de is 17, and it is the second one DNS has to fit. */
  const domain = domainToASCII(domainRaw.toLowerCase());
  if (domain === '') {
    return fail('DOMAIN_INVALID', `"${domainRaw}" is not a valid domain name.`);
  }
  if (domain.endsWith('.')) {
    return fail('DOMAIN_INVALID', 'The domain cannot end with a dot.');
  }

  const labels = domain.split('.');
  if (labels.length < 2) {
    return fail('DOMAIN_NOT_FQDN', `"${domainRaw}" has no domain ending — an address needs a full domain such as company.com.`);
  }
  for (const label of labels) {
    if (label === '' || label.length > MAX_LABEL || !LABEL.test(label)) {
      return fail('DOMAIN_LABEL_INVALID', `"${domainRaw}" is not a valid domain name — "${label || '(empty)'}" is not a usable part of one.`);
    }
  }
  const tld = labels[labels.length - 1];
  if (tld.length < 2 || /^\d+$/.test(tld) || tld.includes('-')) {
    /* An all-numeric last label is a dotted-quad written without brackets,
       which is the same undeliverable case as the IP literal above. */
    return fail('DOMAIN_INVALID', `"${domainRaw}" does not end in a real domain ending.`);
  }

  const address = `${local}@${domain}`;
  if (address.length > MAX_ADDRESS) {
    return fail('ADDRESS_TOO_LONG', `The address is ${address.length} characters; SMTP carries at most ${MAX_ADDRESS}.`);
  }

  return { ok: true, code: 'OK', reason: '', address, local, domain };
}

/**
 * Is this domain reserved by standard, and therefore incapable of taking mail?
 *
 * Checked as a suffix as well as a name, because `mail.example.com` and
 * `anything.test` are reserved by the same rule that reserves the parents.
 */
export function isReservedDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  if (RESERVED_DOMAINS.has(lower)) return true;
  const labels = lower.split('.');
  if (RESERVED_TLDS.has(labels[labels.length - 1])) return true;
  return [...RESERVED_DOMAINS].some((known) => lower.endsWith(`.${known}`));
}

/**
 * Is this a placeholder somebody typed to get past a form?
 *
 * The local part is matched whole, never as a prefix: `testimonials@` and
 * `xavier@` are people, and a substring match would refuse to email them.
 * Plus-addressing is stripped first for the same reason it is on role
 * addresses — `test+2@` is the same placeholder.
 */
export function isPlaceholderAddress(local: string): boolean {
  const base = local.toLowerCase().replace(/^"|"$/g, '').split('+')[0];
  if (PLACEHOLDER_LOCAL_PARTS.has(base)) return true;
  // test.user, test_1, test-account: a placeholder root followed only by
  // digits or a separator. Anchored so "tesla" and "bartender" are untouched.
  return /^(?:test|demo|sample|dummy|fake|placeholder|qa|foo|bar)(?:[._-]?\d*|[._-](?:user|account|mail|email|address|\d+))$/.test(base);
}

/** Is this a shared/functional mailbox rather than a person's? */
export function isRoleAddress(local: string): boolean {
  // Plus-addressing on a role account is still a role account: sales+eu@ is
  // read by whoever reads sales@.
  const base = local.toLowerCase().split('+')[0];
  return ROLE_LOCAL_PARTS.has(base);
}

/** Is this domain a known throwaway-inbox provider? */
export function isDisposableDomain(domain: string, extra: ReadonlySet<string>): boolean {
  const lower = domain.toLowerCase();
  if (DISPOSABLE_DOMAINS.has(lower) || extra.has(lower)) return true;
  /* Several of these hand out unlimited subdomains (anything.mailinator.com),
     so the parent has to match too. */
  return [...DISPOSABLE_DOMAINS, ...extra].some((known) => lower.endsWith(`.${known}`));
}

/**
 * The domain this was probably meant to be, or null.
 *
 * ONLY FOR THE BIG FREE PROVIDERS. Suggesting a correction to a corporate
 * domain would be guessing about somebody's employer from a two-character
 * difference, and `ada@acme.co` → "did you mean acme.com?" is wrong far more
 * often than it is right.
 */
export function suggestDomain(domain: string): string | null {
  const lower = domain.toLowerCase();
  if (COMMON_DOMAINS.includes(lower)) return null;
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of COMMON_DOMAINS) {
    const distance = editDistance(lower, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= 2 ? best : null;
}
