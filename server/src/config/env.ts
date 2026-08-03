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

export const config: AppConfig = {
  nodeEnv: process.env.NODE_ENV || 'development',
  // 3010, not 3000: the ProjexCloud dev stack owns 3000 and several neighbours on
  // a developer machine running both. Keep in step with client/vite.config.ts's
  // proxy target and scripts/check-ports.js.
  port: parseInt(process.env.PORT || '3010', 10),
  appName: process.env.APP_NAME || 'LeadFlow',

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

  // ProjexCloud SDK gateway — the source of every horizontal capability.
  // When gatewayUrl/apiKey are unset the gateway client reports itself
  // unconfigured and callers apply their documented local fallback.
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
