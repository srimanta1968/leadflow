import dotenv from 'dotenv';
dotenv.config();

/**
 * The server's resolved configuration.
 *
 * Declaring the shape explicitly means a typo in a key is a compile error
 * rather than an `undefined` that only surfaces at runtime, and it documents
 * for a reader what the server actually needs from the environment.
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  appName: string;
  /**
   * Account-lifecycle email. NOT a path to the customer — see
   * platform/email/transport.ts. Absent configuration is a valid deployment
   * state and produces `skipped` sends rather than errors.
   */
  email: {
    sendgridApiKey: string;
    fromAddress: string;
    fromName: string;
    /** Where a verification or invitation link points. Per deployment. */
    appBaseUrl: string;
    timeoutMs: number;
    /** When false, registration issues no token and does not gate on the address. */
    verificationRequired: boolean;
    /**
     * Pre-send address verification — platform/email/addressVerification.ts.
     *
     * Every knob here exists because the right answer differs by deployment,
     * not because the default is uncertain: a demo box wants placeholders let
     * through, production does not, and the SMTP probe is unusable on any
     * network that blocks outbound port 25 (which is most of them, including
     * the EC2 host this runs on).
     */
    addressCheck: {
      /**
       * 'enforce' refuses undeliverable addresses; 'warn' checks and records
       * but sends anyway; 'off' does syntax only and no DNS at all.
       */
      mode: 'off' | 'warn' | 'enforce';
      dnsTimeoutMs: number;
      /** SMTP RCPT probing. Off unless a deployment has port 25 and wants it. */
      probe: boolean;
      probeTimeoutMs: number;
      /** The sender used in the probe's MAIL FROM. Never receives anything. */
      probeFrom: string;
      /** The name given in EHLO. Should be a hostname the domain resolves. */
      heloName: string;
      blockPlaceholder: boolean;
      blockDisposable: boolean;
      blockRole: boolean;
      /** Extra throwaway-inbox domains, on top of the built-in list. */
      disposableDomains: ReadonlySet<string>;
      cacheTtlMs: {
        deliverable: number;
        undeliverable: number;
        risky: number;
        unknown: number;
        /** Per-domain MX answers, which change far less often than verdicts. */
        mx: number;
      };
    };
  };
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    ssl: boolean;
    poolMin: number;
    poolMax: number;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  bcryptRounds: number;
  corsOrigin: string[];
  logLevel: string;
  logFormat: string;
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  bodyLimit: string;
  /**
   * A privileged account seeded in non-production environments so the API
   * contract suite has a caller who holds the governed roles. Inert unless both
   * values are set, and refused outright when NODE_ENV is production.
   */
  devSeed: {
    adminEmail: string;
    adminPassword: string;
    stewardEmail: string;
    stewardPassword: string;
    privacyEmail: string;
    privacyPassword: string;
  };
  outbox: {
    /**
     * How often the outbox dispatcher and the projection consumer tick.
     *
     * Both are catch-up mechanisms rather than the primary path — the receiver
     * advances projections inline and callers enqueue synchronously — so this
     * only bounds how long a MISSED one waits, not normal latency.
     */
    tickMs: number;
  };
  dataReview: {
    /**
     * How often the eight governed case detectors sweep.
     *
     * Far slower than the outbox tick, and deliberately: a review case is a
     * question for a human that will sit in a queue for hours either way, so
     * sweeping five upstreams every few seconds would spend the tenant rate
     * limits rediscovering the same findings. Event-driven passes cover the
     * cases where latency actually matters.
     */
    sweepMs: number;
  };
  projexCloud: {
    gatewayUrl: string;
    apiKey: string;
    tenantId: string;
    /**
     * The CUSTOMER, once they own more than one app.
     *
     * `tenantId` above is app-scoped — a ProjexCloud tenant row has a NOT NULL
     * app_id, so it belongs to exactly one app. A customer running two apps is
     * a root tenant with a child tenant per app. Empty while there is one app,
     * where root and child are the same row.
     */
    rootTenantId: string;
    appId: string;
    /**
     * Shared secret for verifying INBOUND ProjexCloud webhook deliveries.
     *
     * Distinct from apiKey, which authenticates LeadFlow when it calls OUT. This
     * one proves a delivery arriving here really came from ProjexCloud, and it
     * has to be separate: a single value used in both directions means anybody
     * who can read our outbound credential can forge inbound events.
     *
     * Empty fails CLOSED — the receiver refuses every delivery rather than
     * trusting whatever arrives, because an unverifiable event that reaches the
     * projections is indistinguishable from a real one afterwards.
     */
    webhookSecret: string;
    /**
     * A REFERENCE to the signing key, never the key itself.
     *
     * sdk-webhook resolves the ref through its own key resolver; sending the
     * literal secret would put it in the producer's request log for no benefit.
     */
    webhookSigningKeyRef: string;
    /**
     * Where ProjexCloud should POST deliveries. Must be https:// — sdk-webhook
     * refuses plain http, and rightly: the HMAC proves origin, not secrecy, and
     * the payloads carry personal data.
     */
    webhookReceiverUrl: string;
    /**
     * The sdk-policy policy evaluated for browser-capture domain restrictions.
     *
     * Its ABSENCE is meaningful: no policy id means the tenant has declared no
     * domain restriction, so capture is permitted. Only when one IS configured
     * does an unreachable policy engine fail closed — you cannot fail closed
     * against a rule nobody wrote.
     */
    capturePolicyId: string;
    /**
     * The sdk-approval route a steward decision is submitted through.
     *
     * Its ABSENCE is meaningful in the opposite direction to `capturePolicyId`:
     * with no route, a decision cannot be RECORDED upstream at all, because
     * `enqueueStewardReview` requires a route_id and `adjudicateCandidate`
     * requires the step it produces. So the modal must refuse the decision and
     * say why, rather than let a steward believe they have settled a case that
     * nothing durable witnessed. An unrecorded adjudication is worse than a
     * blocked one: the case leaves their queue and no reversibility reference
     * exists to undo it by.
     */
    stewardRouteId: string;

    timeoutMs: number;
    /**
     * ProjexCloud `sdk-identity`, the issuer of the session tokens this app
     * verifies. Separate from the gateway block above because the two are
     * different trust relationships: the gateway authenticates LeadFlow with an
     * API key, whereas this verifies a token minted for an END USER.
     */
    identity: {
      /**
       * Base URL of the issuer. OIDC discovery hangs off this
       * (`/.well-known/openid-configuration`). Empty disables verification and
       * LeadFlow keeps using its own locally-issued tokens.
       */
      issuerUrl: string;
      /**
       * The `aud` every token must carry. NOT read from the discovery document —
       * OIDC does not publish audience there, because it identifies the client
       * rather than the issuer. Defaults to the app id, which is what the
       * gateway scopes by.
       */
      audience: string;
      /** How long a fetched key set is trusted before it is re-read. */
      jwksTtlMs: number;
      /**
       * Seconds of clock skew tolerated on exp/nbf. Small on purpose: this is
       * cover for imperfectly synced clocks, not a grace period for expired
       * tokens.
       */
      clockToleranceSec: number;
    };
  };
}

/**
 * Read EMAIL_ADDRESS_CHECK_MODE, defaulting to 'enforce'.
 *
 * An unrecognised value falls back to the default and SAYS SO rather than
 * silently disabling the check: `EMAIL_ADDRESS_CHECK_MODE=true` in a .env file
 * is a plausible mistake, and quietly reading it as "off" would turn a typo
 * into an unnoticed loss of protection.
 */
function parseCheckMode(raw: string | undefined): 'off' | 'warn' | 'enforce' {
  const value = (raw || '').trim().toLowerCase();
  if (value === '') return 'enforce';
  if (value === 'off' || value === 'warn' || value === 'enforce') return value;
  console.warn(
    `[email] EMAIL_ADDRESS_CHECK_MODE="${raw}" is not one of off|warn|enforce — using enforce.`
  );
  return 'enforce';
}

export const config: AppConfig = {
  nodeEnv: process.env.NODE_ENV || 'development',
  // 3010, not 3000: the ProjexCloud dev stack owns 3000 and several neighbours on
  // a developer machine running both. Keep in step with client/vite.config.ts's
  // proxy target and scripts/check-ports.js.
  port: parseInt(process.env.PORT || '3010', 10),
  appName: process.env.APP_NAME || 'LeadFlow',

  // Account-lifecycle email
  email: {
    sendgridApiKey: process.env.SENDGRID_API_KEY || '',
    fromAddress: process.env.EMAIL_FROM_ADDRESS || '',
    fromName: process.env.EMAIL_FROM_NAME || process.env.APP_NAME || 'LeadFlow',
    // Defaults to the browser origin, which is the only address a link in an
    // email can usefully point at — the API origin would 404 in a mail client.
    appBaseUrl:
      process.env.APP_BASE_URL || process.env.CORS_ORIGIN?.split(',')[0] || 'http://localhost:5173',
    timeoutMs: parseInt(process.env.EMAIL_TIMEOUT_MS || '10000', 10),
    /* OPT-IN, and off by default. Turning verification on before a provider is
       configured would lock every new account out of a product that had been
       working — so this stays false until somebody sets it deliberately, and
       the send path warns when it is on with no provider behind it. */
    verificationRequired: process.env.EMAIL_VERIFICATION_REQUIRED === 'true',

    addressCheck: {
      /* ON BY DEFAULT, unlike verificationRequired above, and the difference is
         which way each fails. Requiring verification with no provider locks
         everybody out; checking an address costs one DNS query and, when the
         resolver is unreachable, returns `unknown` and sends anyway. There is
         no configuration in which having this on is worse than having it off,
         so it does not wait to be switched on. */
      mode: parseCheckMode(process.env.EMAIL_ADDRESS_CHECK_MODE),
      dnsTimeoutMs: parseInt(process.env.EMAIL_DNS_TIMEOUT_MS || '5000', 10),
      /* OFF. Outbound port 25 is blocked on EC2 unless AWS grants an exception,
         and probing without it means every check burns its timeout to learn
         nothing. See the note at probeMailbox(). */
      probe: process.env.EMAIL_SMTP_PROBE === 'true',
      probeTimeoutMs: parseInt(process.env.EMAIL_SMTP_PROBE_TIMEOUT_MS || '8000', 10),
      /* A real address on our own domain. Some receivers reject the null sender
         outright, and a probe from an address that does not exist is exactly
         what a spam filter is built to notice. */
      probeFrom:
        process.env.EMAIL_SMTP_PROBE_FROM ||
        process.env.EMAIL_FROM_ADDRESS ||
        'postmaster@localhost',
      heloName:
        process.env.EMAIL_SMTP_HELO_NAME ||
        (process.env.EMAIL_FROM_ADDRESS || '').split('@')[1] ||
        'localhost',
      /* The two defaults that differ from "report only": a placeholder and a
         throwaway inbox are reachable, so no fact forces a refusal — but a
         sequence sent to 400 of them in an import is a deliverability incident,
         and that is the failure worth defaulting against. */
      blockPlaceholder: process.env.EMAIL_BLOCK_PLACEHOLDER !== 'false',
      blockDisposable: process.env.EMAIL_BLOCK_DISPOSABLE !== 'false',
      /* Off: sales@ and info@ are the correct address for a great many B2B
         conversations, and refusing them would refuse real business. */
      blockRole: process.env.EMAIL_BLOCK_ROLE === 'true',
      disposableDomains: new Set(
        (process.env.EMAIL_DISPOSABLE_DOMAINS || '')
          .split(',')
          .map((d) => d.trim().toLowerCase())
          .filter((d) => d !== '')
      ),
      cacheTtlMs: {
        deliverable: parseInt(process.env.EMAIL_CACHE_TTL_DELIVERABLE_MS || String(30 * 24 * 60 * 60 * 1000), 10),
        /* Days, not weeks: a domain acquires an MX record the day somebody
           finishes setting up their mail, and a month-long cache would keep
           refusing them long after they were reachable. */
        undeliverable: parseInt(process.env.EMAIL_CACHE_TTL_UNDELIVERABLE_MS || String(3 * 24 * 60 * 60 * 1000), 10),
        risky: parseInt(process.env.EMAIL_CACHE_TTL_RISKY_MS || String(24 * 60 * 60 * 1000), 10),
        /* Minutes. `unknown` describes our network at one moment, and caching
           that for hours would extend a blip into an outage. */
        unknown: parseInt(process.env.EMAIL_CACHE_TTL_UNKNOWN_MS || String(5 * 60 * 1000), 10),
        mx: parseInt(process.env.EMAIL_CACHE_TTL_MX_MS || String(6 * 60 * 60 * 1000), 10),
      },
    },
  },

  // Database
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    name: process.env.DB_NAME || 'leadflow_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    ssl: process.env.DB_SSL === 'true',
    poolMin: parseInt(process.env.DB_POOL_MIN || '2', 10),
    poolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),
  },

  // Security
  jwt: {
    secret: process.env.JWT_SECRET || 'your-secret-key',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '10', 10),

  // CORS
  corsOrigin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5173'],

  // Logging
  logLevel: process.env.LOG_LEVEL || 'debug',
  logFormat: process.env.LOG_FORMAT || 'dev',

  // Rate limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },

  // Body parser
  bodyLimit: process.env.BODY_PARSER_LIMIT || '10mb',

  devSeed: {
    adminEmail: process.env.DEV_ADMIN_EMAIL || '',
    adminPassword: process.env.DEV_ADMIN_PASSWORD || '',
    // A steward is a SEPARATE account, not an elevation of the admin one:
    // users.role is a single column, and the capture-resolution grants belong to
    // data_steward alone. Without this the api suite cannot exercise those
    // endpoints with any identity — every dataset answers 403.
    stewardEmail: process.env.DEV_STEWARD_EMAIL || '',
    stewardPassword: process.env.DEV_STEWARD_PASSWORD || '',
    privacyEmail: process.env.DEV_PRIVACY_EMAIL || '',
    privacyPassword: process.env.DEV_PRIVACY_PASSWORD || '',
  },

  // ProjexCloud SDK gateway — the source of every horizontal capability.
  // When gatewayUrl/apiKey are unset the gateway client reports itself
  // unconfigured and callers apply their documented local fallback.
  outbox: {
    tickMs: Number(process.env.OUTBOX_TICK_MS || 15000),
  },
  dataReview: {
    sweepMs: Number(process.env.DATA_REVIEW_SWEEP_MS || 900000),
  },
  projexCloud: {
    gatewayUrl: process.env.PROJEXCLOUD_GATEWAY_URL || '',
    apiKey: process.env.PROJEXCLOUD_API_KEY || '',
    tenantId: process.env.PROJEXCLOUD_TENANT_ID || '',
    // Left empty until a customer has a second app. Deliberately NOT defaulted
    // to tenantId here — the fallback belongs in resolveTenantContext, where it
    // is one decision with a comment rather than a value that silently looks
    // like it was configured.
    rootTenantId: process.env.PROJEXCLOUD_ROOT_TENANT_ID || '',
    // Optional second scope dimension, for a gateway that hosts more than one
    // application under a tenant. Empty by default, and the header is omitted
    // entirely when empty, so a gateway that scopes by tenant alone is
    // unaffected.
    appId: process.env.PROJEXCLOUD_APP_ID || '',
    webhookSecret: process.env.PROJEXCLOUD_WEBHOOK_SECRET || '',
    webhookSigningKeyRef: process.env.PROJEXCLOUD_WEBHOOK_SIGNING_KEY_REF || '',
    webhookReceiverUrl: process.env.PROJEXCLOUD_WEBHOOK_RECEIVER_URL || '',
    capturePolicyId: process.env.PROJEXCLOUD_CAPTURE_POLICY_ID || '',
    stewardRouteId: process.env.PROJEXCLOUD_STEWARD_ROUTE_ID || '',
    timeoutMs: parseInt(process.env.PROJEXCLOUD_TIMEOUT_MS || '8000', 10),
    identity: {
      issuerUrl: process.env.PROJEXCLOUD_IDENTITY_URL || '',
      // Falls back to the app id: the gateway already scopes by it, so a
      // deployment that has set one has effectively named its audience.
      audience: process.env.PROJEXCLOUD_AUDIENCE || process.env.PROJEXCLOUD_APP_ID || '',
      // Ten minutes. Long enough that a busy process is not re-reading the key
      // set constantly, short enough that a retired key stops being accepted
      // promptly — and an unknown kid forces an immediate re-read anyway, so a
      // rotation is picked up without waiting for this to lapse.
      jwksTtlMs: parseInt(process.env.PROJEXCLOUD_JWKS_TTL_MS || '600000', 10),
      clockToleranceSec: parseInt(process.env.PROJEXCLOUD_CLOCK_TOLERANCE_SEC || '5', 10),
    },
  },
};
