import { Resolver } from 'dns/promises';
import { createConnection, type Socket } from 'net';
import { randomBytes } from 'crypto';
import { config } from '../../config/env';
import { dataService } from '../../services/DataService';
import {
  isDisposableDomain, isPlaceholderAddress, isReservedDomain, isRoleAddress,
  parseAddress, suggestDomain,
} from './addressSyntax';

/**
 * Does this address exist, and can anything actually deliver to it?
 *
 * FOUR STAGES, EACH CHEAPER THAN THE NEXT AND EACH ABLE TO END IT.
 *
 *   1. SYNTAX — a parser, not a pattern (see addressSyntax.ts). No network.
 *   2. POLICY — reserved, placeholder, disposable, role, likely typo. No network.
 *   3. MX — does the domain publish a mail exchanger, or resolve at all? One
 *      DNS query, cached per domain. This is the "is there an exchange server
 *      behind this name" question, and it is the last stage that can be relied
 *      on everywhere.
 *   4. MAILBOX — an SMTP RCPT probe against that exchanger. OFF BY DEFAULT, for
 *      reasons given at probeMailbox().
 *
 * THE VERDICTS ARE FOUR, NOT TWO, and that is the whole design. A boolean
 * `valid` forces every uncertain answer into one of two wrong ones: call a
 * greylisted mailbox invalid and a real customer never hears from us; call a
 * non-existent domain valid and we send a message that bounces and costs
 * sending reputation. `unknown` is a real state and this reports it rather than
 * guessing, which is also why NOTHING HERE THROWS — a resolver being
 * unreachable is not a reason to fail a registration.
 *
 * WHAT IT CANNOT DO, said plainly because the alternative is a promise this
 * cannot keep: without stage 4 there is no way to know a specific mailbox
 * exists, and WITH stage 4 there still is not, for any of the large providers.
 * Gmail, Outlook and everything behind a catch-all answer 250 to every RCPT and
 * bounce afterwards. Stage 3 is therefore what the product should rely on: it
 * catches the mistyped and dead domains, which is where the bounces come from.
 */

export type Verdict = 'deliverable' | 'undeliverable' | 'risky' | 'unknown';

export type VerificationCode =
  // Deliverable
  | 'OK'
  // Undeliverable — a fact, not a policy
  | 'SYNTAX_INVALID'
  | 'RESERVED_DOMAIN'
  | 'DOMAIN_NOT_FOUND'
  | 'NO_MAIL_EXCHANGER'
  | 'NULL_MX'
  | 'MAILBOX_NOT_FOUND'
  // Risky — reachable, but probably not who you meant
  | 'PLACEHOLDER_ADDRESS'
  | 'DISPOSABLE_DOMAIN'
  | 'ROLE_ADDRESS'
  | 'LIKELY_TYPO'
  | 'CATCH_ALL_DOMAIN'
  | 'MAILBOX_FULL'
  // Unknown — a fact about our network, not about the address
  | 'DNS_UNAVAILABLE'
  | 'PROBE_UNAVAILABLE'
  | 'CHECK_DISABLED';

export type StageResult = 'pass' | 'fail' | 'unknown' | 'skipped';

export interface AddressVerification {
  /** As supplied, for echoing back beside the field the user typed in. */
  input: string;
  /** Trimmed, unwrapped, domain lower-cased and punycoded. */
  address: string;
  domain: string;
  verdict: Verdict;
  code: VerificationCode;
  /** One sentence, written for the person who typed the address. */
  reason: string;
  checks: {
    syntax: StageResult;
    /** Does the domain resolve at all? */
    domain: StageResult;
    /** Does it publish a mail exchanger (or an implicit one)? */
    mx: StageResult;
    /** Does the specific mailbox answer? `skipped` unless probing is enabled. */
    mailbox: StageResult;
  };
  /** Exchanger hostnames in priority order. Empty when there are none. */
  mail_exchangers: string[];
  is_role_address: boolean;
  is_disposable: boolean;
  is_placeholder: boolean;
  /** A correction to offer, never one to apply. */
  did_you_mean: string | null;
  checked_at: string;
  /** True when this answer came from cache rather than the network. */
  cached: boolean;
}

/** What the send gate concluded from a verification. */
export interface SendDecision {
  allowed: boolean;
  /** Present whenever `allowed` is false. */
  reason: string | null;
  verdict: Verdict;
  code: VerificationCode;
}

interface MxLookup {
  status: 'ok' | 'implicit' | 'null_mx' | 'no_mx' | 'nxdomain' | 'unavailable';
  hosts: string[];
  detail: string;
}

interface ProbeOutcome {
  status: 'accepted' | 'rejected' | 'full' | 'catch_all' | 'unavailable';
  smtpCode: number | null;
  detail: string;
}

/* ------------------------------------------------------------------ caches */

interface CacheEntry<T> { value: T; expiresAt: number }

/**
 * The in-process caches.
 *
 * TWO OF THEM, KEYED DIFFERENTLY, because they answer different questions at
 * different rates. An import of 5,000 rows from one company is 5,000 address
 * lookups and ONE domain lookup, and keying only by address would make it 5,000
 * DNS queries against a domain that answered the first time.
 *
 * BOUNDED. An unbounded Map behind a public endpoint is a memory-exhaustion
 * bug with a nice name; oldest-first eviction is crude and correct, since the
 * durable copy is in Postgres and a miss costs one query.
 */
const MAX_MEMO = 5_000;
const domainMemo = new Map<string, CacheEntry<MxLookup>>();
const addressMemo = new Map<string, CacheEntry<AddressVerification>>();

function memoGet<T>(memo: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = memo.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    memo.delete(key);
    return null;
  }
  return hit.value;
}

function memoSet<T>(memo: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  if (memo.size >= MAX_MEMO) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** How long a verdict is worth keeping. See the note in migration 036. */
function ttlFor(verdict: Verdict): number {
  const ttl = config.email.addressCheck.cacheTtlMs;
  switch (verdict) {
    case 'deliverable': return ttl.deliverable;
    case 'undeliverable': return ttl.undeliverable;
    case 'risky': return ttl.risky;
    default: return ttl.unknown;
  }
}

/* --------------------------------------------------------------------- DNS */

/**
 * Find the mail exchangers for a domain.
 *
 * THE FALLBACK TO A/AAAA IS NOT A GUESS. RFC 5321 §5.1 says a domain with an
 * address record and no MX record is its own mail exchanger, and a great many
 * small business domains are configured exactly that way. Treating "no MX" as
 * "cannot receive mail" would refuse to email a real customer, which is the
 * expensive direction of this error.
 *
 * A NULL MX IS THE OPPOSITE, and the one DNS answer that is a definitive no:
 * RFC 7505 defines a single `.` exchanger as the domain's owner stating that it
 * accepts no mail at all. That is the domain telling us, and it is believed.
 */
async function resolveExchangers(domain: string): Promise<MxLookup> {
  const cached = memoGet(domainMemo, domain);
  if (cached) return cached;

  const resolver = new Resolver({
    timeout: config.email.addressCheck.dnsTimeoutMs,
    tries: 2,
  });

  let result: MxLookup;
  try {
    const records = await resolver.resolveMx(domain);
    const usable = records.filter((r) => r.exchange && r.exchange !== '.');
    if (records.length > 0 && usable.length === 0) {
      result = {
        status: 'null_mx', hosts: [],
        detail: 'The domain publishes a null MX record, which is its owner declaring that it accepts no email.',
      };
    } else if (usable.length === 0) {
      result = await addressRecordFallback(resolver, domain);
    } else {
      result = {
        status: 'ok',
        hosts: usable.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.replace(/\.$/, '')),
        detail: '',
      };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENODATA' || code === 'ENOTFOUND') {
      /* ENODATA means the domain exists with no MX; ENOTFOUND is returned by
         some resolvers for both "no such domain" and "no such record type", so
         neither can be concluded from without asking for an address record. */
      result = await addressRecordFallback(resolver, domain);
    } else {
      result = {
        status: 'unavailable', hosts: [],
        detail: `The domain could not be checked (${code || 'resolver error'}).`,
      };
    }
  }

  /* A failed lookup is cached BRIEFLY and a successful one for hours. Caching a
     resolver timeout for six hours would turn a thirty-second network blip into
     an afternoon of refused sign-ups. */
  const ttl = result.status === 'unavailable'
    ? config.email.addressCheck.cacheTtlMs.unknown
    : config.email.addressCheck.cacheTtlMs.mx;
  memoSet(domainMemo, domain, result, ttl);
  return result;
}

async function addressRecordFallback(resolver: Resolver, domain: string): Promise<MxLookup> {
  try {
    const a = await resolver.resolve4(domain);
    if (a.length > 0) {
      return { status: 'implicit', hosts: [domain], detail: 'The domain has no MX record but resolves, so it is its own mail exchanger (RFC 5321 §5.1).' };
    }
  } catch {
    // Fall through to AAAA — an IPv6-only host is unusual but not impossible.
  }
  try {
    const aaaa = await resolver.resolve6(domain);
    if (aaaa.length > 0) {
      return { status: 'implicit', hosts: [domain], detail: 'The domain has no MX record but resolves over IPv6, so it is its own mail exchanger.' };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { status: 'nxdomain', hosts: [], detail: 'The domain does not exist.' };
    }
    return { status: 'unavailable', hosts: [], detail: `The domain could not be checked (${code || 'resolver error'}).` };
  }
  return { status: 'no_mx', hosts: [], detail: 'The domain exists but publishes no way to receive email.' };
}

/* -------------------------------------------------------------------- SMTP */

/**
 * Ask the mail exchanger whether it would accept this recipient.
 *
 * OFF BY DEFAULT, and it should stay off in most deployments. Three reasons,
 * none of them theoretical:
 *
 *   - PORT 25 OUTBOUND IS BLOCKED on EC2 (and on most cloud networks) until an
 *     account-level exception is granted. LeadFlow's production box is EC2, so
 *     with the probe enabled every check would spend its full timeout and
 *     return `unknown` — slower than not asking, and no more informative.
 *   - IT COSTS SENDER REPUTATION. A host that opens sessions and disconnects
 *     without sending gets rate-limited and eventually blocklisted by the large
 *     providers, which damages the deliverability of real mail to buy a guess.
 *   - THE ANSWER IS OFTEN A LIE. Catch-all domains, Gmail and Outlook accept
 *     every RCPT and decide later, which is why a catch-all is detected here
 *     explicitly and downgrades the verdict to `risky` rather than being
 *     reported as a mailbox that exists.
 *
 * IT NEVER SENDS A MESSAGE. The session stops at RCPT and quits; DATA is never
 * issued, so nothing can arrive in the mailbox being asked about.
 */
async function probeMailbox(host: string, address: string, domain: string): Promise<ProbeOutcome> {
  const timeoutMs = config.email.addressCheck.probeTimeoutMs;
  const helo = config.email.addressCheck.heloName;
  const from = config.email.addressCheck.probeFrom;
  const decoy = `${randomBytes(9).toString('hex')}@${domain}`;

  return new Promise<ProbeOutcome>((resolve) => {
    let socket: Socket;
    try {
      socket = createConnection({ host, port: 25 });
    } catch (error) {
      resolve({ status: 'unavailable', smtpCode: null, detail: error instanceof Error ? error.message : 'connect failed' });
      return;
    }

    let buffer = '';
    let stage: 'greeting' | 'ehlo' | 'from' | 'decoy' | 'target' = 'greeting';
    let triedHelo = false;
    let settled = false;

    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      try {
        socket.write('QUIT\r\n');
      } catch {
        // The connection is going away regardless; QUIT is a courtesy.
      }
      socket.destroy();
      resolve(outcome);
    };

    // A deadline for the WHOLE session, not just for one silent socket. A
    // server that answers every command slowly would never trip the idle
    // timeout and would hold a request open for as long as it liked.
    const deadline = setTimeout(
      () => finish({ status: 'unavailable', smtpCode: null, detail: 'the mail server did not finish the check in time' }),
      timeoutMs,
    );
    deadline.unref();

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish({ status: 'unavailable', smtpCode: null, detail: 'the mail server did not answer in time' }));
    socket.on('error', (error) => finish({ status: 'unavailable', smtpCode: null, detail: error.message }));
    socket.on('close', () => {
      clearTimeout(deadline);
      finish({ status: 'unavailable', smtpCode: null, detail: 'the mail server closed the connection' });
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // A reply is finished when a line has a SPACE after the code; a hyphen
      // means more lines follow (RFC 5321 §4.2.1), and acting on the first line
      // of a multi-line EHLO answer is the classic way to break this.
      const match = /^(\d{3}) [^\n]*$/m.exec(buffer.replace(/\r/g, ''));
      if (!match) return;
      const code = parseInt(match[1], 10);
      buffer = '';

      switch (stage) {
        case 'greeting':
          if (code !== 220) return finish({ status: 'unavailable', smtpCode: code, detail: `the mail server refused the connection (${code})` });
          stage = 'ehlo';
          socket.write(`EHLO ${helo}\r\n`);
          return;

        case 'ehlo':
          if (code >= 500 && !triedHelo) {
            // A server too old for EHLO still speaks HELO.
            triedHelo = true;
            socket.write(`HELO ${helo}\r\n`);
            return;
          }
          if (code !== 250) return finish({ status: 'unavailable', smtpCode: code, detail: `the mail server rejected the greeting (${code})` });
          stage = 'from';
          socket.write(`MAIL FROM:<${from}>\r\n`);
          return;

        case 'from':
          if (code !== 250) return finish({ status: 'unavailable', smtpCode: code, detail: `the mail server would not accept a sender (${code})` });
          /* THE DECOY GOES FIRST. Asking about a random mailbox at the same
             domain is the only way to tell "yes, that person exists" from "yes,
             to everything" — and it has to be asked before the real one, or a
             catch-all has already given the answer we would misread. */
          stage = 'decoy';
          socket.write(`RCPT TO:<${decoy}>\r\n`);
          return;

        case 'decoy':
          if (code >= 200 && code < 300) {
            return finish({
              status: 'catch_all', smtpCode: code,
              detail: 'The domain accepts mail for every address, so whether this particular mailbox exists cannot be established.',
            });
          }
          stage = 'target';
          socket.write(`RCPT TO:<${address}>\r\n`);
          return;

        case 'target':
          if (code >= 200 && code < 300) {
            return finish({ status: 'accepted', smtpCode: code, detail: '' });
          }
          if (code === 452 || code === 552) {
            return finish({ status: 'full', smtpCode: code, detail: 'The mailbox exists but is over quota.' });
          }
          if (code >= 500) {
            return finish({ status: 'rejected', smtpCode: code, detail: `The mail server says there is no such mailbox (${code}).` });
          }
          /* 4xx is a deferral — greylisting, rate limiting, a server having a
             bad afternoon. It says nothing about the address and must not be
             recorded as though it did. */
          return finish({ status: 'unavailable', smtpCode: code, detail: `The mail server deferred the check (${code}).` });

        default:
          return;
      }
    });
  });
}

/* ----------------------------------------------------------- the algorithm */

function build(
  input: string, address: string, domain: string,
  verdict: Verdict, code: VerificationCode, reason: string,
  checks: AddressVerification['checks'],
  extras: Partial<AddressVerification> = {},
): AddressVerification {
  return {
    input, address, domain, verdict, code, reason, checks,
    mail_exchangers: [],
    is_role_address: false,
    is_disposable: false,
    is_placeholder: false,
    did_you_mean: null,
    checked_at: new Date().toISOString(),
    cached: false,
    ...extras,
  };
}

/**
 * Verify one address.
 *
 * @param raw     Whatever the user or the import file supplied.
 * @param options `probe` overrides the deployment default for stage 4;
 *                `skipCache` forces a fresh check, for a "check again" button.
 * @returns       The verdict. NEVER THROWS and never rejects.
 */
export async function verifyAddress(
  raw: string,
  options: { probe?: boolean; skipCache?: boolean } = {},
): Promise<AddressVerification> {
  const settings = config.email.addressCheck;

  /* Stage 1 — syntax. Runs even when checking is disabled, because a string
     with no @ in it is not a network question and answering "unknown" to it
     would be silly. */
  const parsed = parseAddress(raw);
  if (!parsed.ok) {
    return build(raw, '', '', 'undeliverable', 'SYNTAX_INVALID', parsed.reason, {
      syntax: 'fail', domain: 'skipped', mx: 'skipped', mailbox: 'skipped',
    });
  }
  const { address, local, domain } = parsed;

  if (settings.mode === 'off') {
    return build(raw, address, domain, 'unknown', 'CHECK_DISABLED',
      'Address checking is disabled in this deployment; only the format was checked.',
      { syntax: 'pass', domain: 'skipped', mx: 'skipped', mailbox: 'skipped' });
  }

  if (!options.skipCache) {
    const cached = memoGet(addressMemo, address) ?? await readCachedVerdict(address);
    if (cached) return { ...cached, input: raw, cached: true };
  }

  /* Stage 2 — policy. All local, all cheap, and RESERVED IS CHECKED FIRST
     because example.com resolves: it has an A record and would sail past a DNS
     check while being, by IETF reservation, incapable of receiving anything. */
  const roleAddress = isRoleAddress(local);
  const disposable = isDisposableDomain(domain, settings.disposableDomains);
  const placeholder = isPlaceholderAddress(local);
  const suggestion = suggestDomain(domain);
  const flags = {
    is_role_address: roleAddress,
    is_disposable: disposable,
    is_placeholder: placeholder,
    did_you_mean: suggestion ? `${local}@${suggestion}` : null,
  };

  if (isReservedDomain(domain)) {
    return finalise(build(raw, address, domain, 'undeliverable', 'RESERVED_DOMAIN',
      `"${domain}" is a reserved documentation or test domain — it is guaranteed by standard never to receive email.`,
      { syntax: 'pass', domain: 'fail', mx: 'skipped', mailbox: 'skipped' }, flags));
  }

  /* Stage 3 — the mail exchanger. This is the check the product relies on. */
  const mx = await resolveExchangers(domain);

  if (mx.status === 'nxdomain') {
    return finalise(build(raw, address, domain, 'undeliverable', 'DOMAIN_NOT_FOUND',
      `There is no domain called "${domain}"${suggestion ? ` — did you mean ${suggestion}?` : '.'}`,
      { syntax: 'pass', domain: 'fail', mx: 'skipped', mailbox: 'skipped' }, flags));
  }
  if (mx.status === 'null_mx') {
    return finalise(build(raw, address, domain, 'undeliverable', 'NULL_MX',
      `"${domain}" publishes a null MX record: its owner has declared that it accepts no email at all.`,
      { syntax: 'pass', domain: 'pass', mx: 'fail', mailbox: 'skipped' }, flags));
  }
  if (mx.status === 'no_mx') {
    return finalise(build(raw, address, domain, 'undeliverable', 'NO_MAIL_EXCHANGER',
      `"${domain}" exists but has no mail server behind it, so email sent there cannot be delivered.`,
      { syntax: 'pass', domain: 'pass', mx: 'fail', mailbox: 'skipped' }, flags));
  }
  if (mx.status === 'unavailable') {
    /* FAIL OPEN, and cached for minutes rather than hours. Our resolver being
       unreachable is not evidence about somebody else's address. */
    return finalise(build(raw, address, domain, 'unknown', 'DNS_UNAVAILABLE',
      `The mail server for "${domain}" could not be looked up just now, so this address has not been confirmed either way.`,
      { syntax: 'pass', domain: 'unknown', mx: 'unknown', mailbox: 'skipped' }, flags));
  }

  const withMx = { ...flags, mail_exchangers: mx.hosts };

  /* Stage 4 — the mailbox itself, when the deployment has asked for it. */
  const probing = options.probe ?? settings.probe;
  if (probing && mx.hosts.length > 0) {
    const outcome = await probeMailbox(mx.hosts[0], address, domain);
    if (outcome.status === 'rejected') {
      return finalise(build(raw, address, domain, 'undeliverable', 'MAILBOX_NOT_FOUND',
        `The mail server for "${domain}" says there is no mailbox called "${local}".`,
        { syntax: 'pass', domain: 'pass', mx: 'pass', mailbox: 'fail' }, withMx));
    }
    if (outcome.status === 'catch_all') {
      return finalise(build(raw, address, domain, 'risky', 'CATCH_ALL_DOMAIN',
        `"${domain}" accepts mail addressed to anything, so whether "${local}" is a real mailbox cannot be confirmed.`,
        { syntax: 'pass', domain: 'pass', mx: 'pass', mailbox: 'unknown' }, withMx));
    }
    if (outcome.status === 'full') {
      return finalise(build(raw, address, domain, 'risky', 'MAILBOX_FULL',
        `The mailbox exists but is over quota, so a message may bounce.`,
        { syntax: 'pass', domain: 'pass', mx: 'pass', mailbox: 'unknown' }, withMx));
    }
    if (outcome.status === 'accepted') {
      return finalise(policyOverlay(build(raw, address, domain, 'deliverable', 'OK',
        `"${address}" is a real mailbox at a domain that accepts mail.`,
        { syntax: 'pass', domain: 'pass', mx: 'pass', mailbox: 'pass' }, withMx), flags));
    }
    // Unavailable: fall through to the MX-only verdict rather than reporting a
    // worse answer than we had before the probe was attempted.
    return finalise(policyOverlay(build(raw, address, domain, 'deliverable', 'OK',
      `"${domain}" has a mail server that accepts email. The mailbox itself could not be checked (${outcome.detail}).`,
      { syntax: 'pass', domain: 'pass', mx: 'pass', mailbox: 'unknown' }, withMx), flags));
  }

  return finalise(policyOverlay(build(raw, address, domain, 'deliverable', 'OK',
    mx.status === 'implicit'
      ? `"${domain}" has no MX record but resolves, so it is its own mail server and can receive email.`
      : `"${domain}" has a mail server (${mx.hosts[0]}) that accepts email.`,
    {
      syntax: 'pass', domain: 'pass', mx: 'pass',
      mailbox: probing ? 'unknown' : 'skipped',
    }, withMx), flags));
}

/**
 * Downgrade a deliverable verdict for what stage 2 found.
 *
 * APPLIED LAST, and only to addresses that are otherwise fine. The order
 * matters: a placeholder at a dead domain should be reported as a dead domain,
 * because that is the fact, and "did you mean" advice about a mailbox nobody
 * could reach anyway is noise.
 */
function policyOverlay(
  result: AddressVerification,
  flags: { is_placeholder: boolean; is_disposable: boolean; is_role_address: boolean; did_you_mean: string | null },
): AddressVerification {
  if (flags.is_placeholder) {
    return {
      ...result, verdict: 'risky', code: 'PLACEHOLDER_ADDRESS',
      reason: `"${result.address}" looks like a placeholder somebody typed to get past a form rather than a real person's address.`,
    };
  }
  if (flags.is_disposable) {
    return {
      ...result, verdict: 'risky', code: 'DISPOSABLE_DOMAIN',
      reason: `"${result.domain}" is a throwaway-inbox provider: the address works now and will stop working shortly.`,
    };
  }
  if (flags.did_you_mean) {
    return {
      ...result, verdict: 'risky', code: 'LIKELY_TYPO',
      reason: `"${result.domain}" takes mail, but it is one character away from ${flags.did_you_mean.split('@')[1]} — did you mean ${flags.did_you_mean}?`,
    };
  }
  if (flags.is_role_address) {
    return {
      ...result, verdict: 'risky', code: 'ROLE_ADDRESS',
      reason: `"${result.address}" is a shared inbox rather than one person's address.`,
    };
  }
  return result;
}

/* ------------------------------------------------------------- persistence */

async function readCachedVerdict(address: string): Promise<AddressVerification | null> {
  try {
    const rows = await dataService.query<{
      address: string; domain: string; verdict: string; code: string; reason: string;
      checks: AddressVerification['checks']; mail_exchangers: string[];
      is_role_address: boolean; is_disposable: boolean; did_you_mean: string | null;
      checked_at: Date;
    }>(
      `SELECT address, domain, verdict, code, reason, checks, mail_exchangers,
              is_role_address, is_disposable, did_you_mean, checked_at
         FROM leadflow_email_address_verification
        WHERE address = $1 AND expires_at > CURRENT_TIMESTAMP`,
      [address],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      input: address,
      address: row.address,
      domain: row.domain,
      verdict: row.verdict as Verdict,
      code: row.code as VerificationCode,
      reason: row.reason,
      checks: row.checks,
      mail_exchangers: row.mail_exchangers ?? [],
      is_role_address: row.is_role_address,
      is_disposable: row.is_disposable,
      is_placeholder: row.code === 'PLACEHOLDER_ADDRESS',
      did_you_mean: row.did_you_mean,
      checked_at: new Date(row.checked_at).toISOString(),
      cached: true,
    };
  } catch (error) {
    /* A cache that cannot be read is a slow check, not a failed one — most
       importantly this is what runs before the table exists on a box whose
       migration has not been applied yet. */
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[email] verification cache read failed for ${address}: ${detail}`);
    return null;
  }
}

/** Cache in memory and in Postgres, then hand the verdict back unchanged. */
function finalise(result: AddressVerification): AddressVerification {
  const ttl = ttlFor(result.verdict);
  memoSet(addressMemo, result.address, result, ttl);

  /* NOT AWAITED. The caller is usually a person waiting on a form; writing the
     cache is bookkeeping, and the catch is inside so an unhandled rejection
     cannot take the process down. */
  void dataService.query(
    `INSERT INTO leadflow_email_address_verification
       (address, domain, verdict, code, reason, checks, mail_exchangers,
        is_role_address, is_disposable, did_you_mean, checked_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7::JSONB, $8, $9, $10,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($11 || ' milliseconds')::INTERVAL)
     ON CONFLICT (address) DO UPDATE SET
       verdict = EXCLUDED.verdict, code = EXCLUDED.code, reason = EXCLUDED.reason,
       checks = EXCLUDED.checks, mail_exchangers = EXCLUDED.mail_exchangers,
       is_role_address = EXCLUDED.is_role_address, is_disposable = EXCLUDED.is_disposable,
       did_you_mean = EXCLUDED.did_you_mean, checked_at = EXCLUDED.checked_at,
       expires_at = EXCLUDED.expires_at`,
    [
      result.address, result.domain, result.verdict, result.code, result.reason,
      JSON.stringify(result.checks), JSON.stringify(result.mail_exchangers),
      result.is_role_address, result.is_disposable, result.did_you_mean, String(ttl),
    ],
  ).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[email] verification cache write failed for ${result.address}: ${detail}`);
  });

  return result;
}

/* ------------------------------------------------------------- the gateway */

/**
 * May we send to this address?
 *
 * BLOCKS ON FACTS, WARNS ON JUDGEMENT. `undeliverable` is the only verdict that
 * stops a send on its own, because it is the only one that means the message
 * has nowhere to go. Everything else is deployment policy — a placeholder and a
 * throwaway inbox are real mailboxes, and whether to write to them is a
 * business decision, so each has its own switch and each defaults to the
 * setting that protects sending reputation.
 *
 * `unknown` ALWAYS PASSES. The alternative is that a DNS outage on our side
 * stops every invitation and password reset in the product, which is a far
 * larger failure than the bounces it would prevent.
 */
export function sendDecision(result: AddressVerification): SendDecision {
  const settings = config.email.addressCheck;
  const base = { verdict: result.verdict, code: result.code };

  if (settings.mode !== 'enforce') {
    return { allowed: true, reason: null, ...base };
  }
  if (result.verdict === 'undeliverable') {
    return { allowed: false, reason: result.reason, ...base };
  }
  if (result.code === 'PLACEHOLDER_ADDRESS' && settings.blockPlaceholder) {
    return { allowed: false, reason: result.reason, ...base };
  }
  if (result.code === 'DISPOSABLE_DOMAIN' && settings.blockDisposable) {
    return { allowed: false, reason: result.reason, ...base };
  }
  if (result.code === 'ROLE_ADDRESS' && settings.blockRole) {
    return { allowed: false, reason: result.reason, ...base };
  }
  return { allowed: true, reason: null, ...base };
}

/**
 * Verify an address and decide about it in one call — what a send path wants.
 */
export async function checkBeforeSending(
  address: string,
): Promise<{ verification: AddressVerification; decision: SendDecision }> {
  const verification = await verifyAddress(address);
  return { verification, decision: sendDecision(verification) };
}

/**
 * Verify many addresses, for an import or a segment.
 *
 * BOUNDED CONCURRENCY, because the point of a bulk check is not to open 5,000
 * simultaneous DNS queries; the domain cache means a single-company import
 * collapses to one lookup anyway. Duplicates are collapsed before the work
 * starts, so a list with the same address forty times costs one check.
 */
export async function verifyAddresses(
  addresses: string[],
  options: { probe?: boolean; concurrency?: number } = {},
): Promise<AddressVerification[]> {
  const limit = Math.max(1, Math.min(options.concurrency ?? 8, 16));
  const unique = [...new Set(addresses.map((a) => a.trim()).filter((a) => a !== ''))];
  const results: AddressVerification[] = [];

  for (let i = 0; i < unique.length; i += limit) {
    const batch = unique.slice(i, i + limit);
    // eslint-disable-next-line no-await-in-loop -- the batching is the point.
    results.push(...await Promise.all(batch.map((a) => verifyAddress(a, { probe: options.probe }))));
  }
  return results;
}

/** For the health endpoint: what is this deployment actually checking? */
export function describeConfiguration(): Record<string, unknown> {
  const settings = config.email.addressCheck;
  return {
    mode: settings.mode,
    stages: {
      syntax: true,
      reserved_and_placeholder: true,
      mx: settings.mode !== 'off',
      mailbox_probe: settings.probe,
    },
    blocks: {
      undeliverable: settings.mode === 'enforce',
      placeholder: settings.mode === 'enforce' && settings.blockPlaceholder,
      disposable: settings.mode === 'enforce' && settings.blockDisposable,
      role: settings.mode === 'enforce' && settings.blockRole,
    },
    mailbox_probe_note: settings.probe
      ? 'SMTP RCPT probing is enabled. It requires outbound port 25, which cloud networks block by default.'
      : 'SMTP RCPT probing is disabled, so a specific mailbox is never confirmed to exist — only that its domain can receive mail.',
  };
}
