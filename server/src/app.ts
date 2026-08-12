import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config/env';
import { reportEmailReadiness } from './platform/email';
import routes from './routes';
import { dataService } from './services/DataService';
import { runMigrations } from './db/migrationRunner';
import { seedVerticalProfile } from './db/verticalSeed';
import { advancePipeline, dispatchOutbox, registerEventReceiver } from './platform/events';
import { seedDevAdmin, seedDevPrivacyOfficer, seedDevSteward } from './db/devSeed';
import { provisionAuditEventTypes } from './platform/audit/eventTypeProvisioner';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { platformSession } from './platform/auth';
import { provisionRoles } from './platform/identity';
import { provisionConsentPurposes } from './platform/consent';
import { tick as runRhythm } from './features/rhythm';
import { dispatchDueReminders } from './features/calendar/calendarService';
import { runDetectors } from './features/dataReview/detectors';
import { seedTemplates } from './db/templateSeed';
import { pollInboundSignals } from './features/sequences';

const app = express();

/**
 * Origins allowed to call the API. The configured CORS_ORIGIN list is merged
 * with the local dev hosts and the ProjexLight environments so the app works
 * out of the box in development without loosening production.
 */
const allowedOrigins = Array.from(
  new Set([
    ...config.corsOrigin,
    // The Vite dev server, which is where browser traffic actually originates.
    'http://localhost:5173',
    // The API's own origin, so tooling that calls it directly is not blocked.
    `http://localhost:${config.port}`,
    'https://projexlight.com',
    'https://dev.projexlight.com',
    'https://cloud.projexlight.com',
  ])
);

app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  })
);
app.use(morgan(config.logFormat));
// The raw body is kept alongside the parsed one so webhook signatures can be
// verified against the EXACT bytes the sender signed. Re-serialising the parsed
// object reorders keys and changes whitespace, so a digest computed over it
// differs from the sender's for payloads that are perfectly valid — and it
// fails only for some senders, depending on their key order, which makes it a
// miserable thing to diagnose.
app.use(
  express.json({
    limit: config.bodyLimit,
    verify: (req, _res, buffer) => {
      if (buffer && buffer.length > 0) {
        (req as express.Request & { rawBody?: string }).rawBody = buffer.toString('utf8');
      }
    },
  })
);
app.use(express.urlencoded({ extended: true }));

/** Liveness and database readiness. Public by design. */
app.get('/health', async (_req, res) => {
  const dbHealthy = await dataService.isHealthy();
  res.status(dbHealthy ? 200 : 503).json({
    status: dbHealthy ? 'ok' : 'degraded',
    database: dbHealthy ? 'up' : 'down',
    timestamp: new Date().toISOString(),
  });
});

// Platform session verification runs BEFORE the routers, so a token that is
// expired, from the wrong issuer or minted for another audience is refused
// without any handler seeing it. Inert until PROJEXCLOUD_IDENTITY_URL is set,
// and it exempts the auth-bootstrap and public-capture paths, which are how a
// caller obtains a session in the first place.
app.use('/api', platformSession);
app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = config.port || 3000;

/**
 * Provision the schema, then start accepting requests.
 *
 * Migrations run BEFORE `listen` so the first request can never reach a handler
 * whose table does not exist yet. A migration failure is fatal — serving against
 * an unknown schema is worse than not serving.
 */
async function bootstrap(): Promise<void> {
  await runMigrations();

  // The vertical profile is projected into its config tables immediately after
  // the schema exists and before anything serves. A screen that reads a stage
  // label from an unseeded table renders a blank pipeline, which looks like a
  // data problem rather than a boot-order one.
  // The approved copy every sequence step dispatches against. Seeded before
  // anything serves, because a cadence pointing at keys that resolve to nothing
  // sends blank messages rather than failing loudly.
  const templates = await seedTemplates();
  console.log(
    `[app] templates: ${templates.created} created, ${templates.alreadyPresent} already present, ${templates.published} published`
  );

  const vertical = await seedVerticalProfile();
  console.log(
    `[app] vertical profile: ${vertical.stages} stages, ${vertical.dispositions} dispositions, `
    + `${vertical.closeReasons} close reasons, ${vertical.kpis} KPIs, ${vertical.purposes} purposes`
    + (vertical.retired > 0 ? `, ${vertical.retired} retired` : ''),
  );

  // Non-production only, and inert unless credentials are configured. Gives the
  // API contract suite a caller holding the governed roles, so it can test the
  // permit path of routing and SLA rather than only the refusal.
  const seed = await seedDevAdmin();
  if (seed.attempted) {
    console.log(`[app] dev admin ${seed.created ? 'created' : 'already present'}`);
  } else if (config.nodeEnv !== 'production') {
    console.log(`[app] dev admin not seeded: ${seed.skipped}`);
  }

  // Stewardship is a SEPARATE account, not more grants on the admin one: the
  // capture-resolution policies grant to data_steward alone, and users.role holds
  // exactly one value. Without this the api suite has no caller that can reach
  // those endpoints, so every dataset answers 403 and the refusal looks like a
  // product bug rather than a missing test identity.
  const stewardSeed = await seedDevSteward();
  const privacySeed = await seedDevPrivacyOfficer();
  void privacySeed;
  if (stewardSeed.attempted) {
    console.log(`[app] dev steward ${stewardSeed.created ? 'created' : 'already present'}`);
  } else if (config.nodeEnv !== 'production') {
    console.log(`[app] dev steward not seeded: ${stewardSeed.skipped}`);
  }

  // Register this application's audit event types. ProjexCloud rejects an append
  // whose type it does not know (OC-2), and emitEvent swallows that rejection —
  // so an unregistered vocabulary silently discards the entire audit trail while
  // the chain still verifies clean because it is empty.
  const eventTypes = await provisionAuditEventTypes();
  if (eventTypes.attempted) {
    console.log(
      `[app] audit event types: ${eventTypes.created} registered, ` +
      `${eventTypes.alreadyPresent} already present, ${eventTypes.failed} failed`
    );
  } else {
    console.log(`[app] audit event types not registered: ${eventTypes.skipped}`);
  }

  // Role provisioning is idempotent, so it runs on EVERY boot rather than once
  // behind a flag: a flag would be a local record of upstream state, and it
  // would be wrong the moment someone edited the tenant directly. Unlike
  // migrations this is NOT fatal — the app serves fine against an identity
  // provider that is temporarily unreachable, and refusing to boot would turn
  // their outage into ours.
  // Consent purposes alongside roles: both are idempotent registrations of the
  // app's own vocabulary, and neither is fatal.
  const purposes = await provisionConsentPurposes();
  if (purposes.attempted) {
    console.log(
      `[app] consent purposes: ${purposes.created} created, ${purposes.alreadyPresent} already present, ${purposes.failed} failed`
    );
  }

  const roles = await provisionRoles();
  if (roles.attempted) {
    console.log(
      `[app] roles provisioned: ${roles.created} created, ${roles.alreadyPresent} already present, ${roles.failed} failed`
    );
  }

  /*
   * Register the webhook receiver with sdk-webhook.
   *
   * Reports `skipped` and returns rather than throwing when the receiver URL,
   * the signing key ref or the tenant is unset — which is every developer
   * machine. A boot that dies because an optional integration is unconfigured is
   * a worse failure than the integration being off.
   */
  const receiver = await registerEventReceiver();
  if (receiver.attempted) {
    console.log(
      `[app] event receiver ${receiver.endpointId ?? 'unregistered'}: `
      + `${receiver.subscribed.length} subscribed, ${receiver.refused.length} refused`,
    );
    for (const r of receiver.refused) {
      console.error(`[app] subscription refused for ${r.eventType}: ${r.reason}`);
    }
  } else {
    console.log(`[app] event receiver not registered: ${receiver.skipped}`);
  }

  /* Said once, at boot. Verification required with no provider configured means
     every new account is issued a token nobody can receive — a deployment
     mistake rather than a code one, and this is the only place it can be caught
     before a user finds it. */
  reportEmailReadiness();

  /*
   * The two background ticks.
   *
   * unref() on both, so a pending timer never holds the process open during a
   * shutdown — a interval that keeps node alive turns SIGTERM into a hang, and
   * the container gets SIGKILLed mid-write instead.
   *
   * Errors are logged and swallowed on purpose: a failed tick must not become an
   * unhandled rejection that takes the API down with it. Both operations are
   * idempotent, so the next tick simply tries again.
   */
  const outboxTimer = setInterval(() => {
    dispatchOutbox().catch((e: Error) => console.error('[outbox] dispatch failed:', e.message));
  }, config.outbox.tickMs);
  outboxTimer.unref();

  const projectionTimer = setInterval(() => {
    advancePipeline().catch((e: Error) => console.error('[events] advance failed:', e.message));
  }, config.outbox.tickMs);
  projectionTimer.unref();

  /*
   * The governed-case sweep (#93, AC3).
   *
   * MUCH SLOWER THAN THE OTHER TWO, and deliberately so. The outbox and the
   * projection pipeline are latency-sensitive; a data-review case is a question
   * for a human that will sit in a queue for hours either way, and sweeping
   * eight detectors across five upstreams every few seconds would spend the
   * tenant's rate limits to find the same findings over and over.
   *
   * Safe to run alongside the event-driven passes because the register
   * deduplicates in the database rather than in the caller: two passes landing
   * on the same finding at the same instant produce one case, not two.
   *
   * unref()'d like the others, so a pending sweep never turns SIGTERM into a
   * hang, and failures are logged and swallowed — the next tick simply retries.
   */
  /*
   * Inbound signals: replies, hard bounces and SMS keywords.
   *
   * POLLED because sdk-deliverability emits no events - it exposes reply and
   * bounce events as read endpoints only. Runs more often than the detector
   * sweep because a reply that leaves a cadence running for another hour is a
   * message arguing with a human, which is the failure the stop rules exist to
   * prevent.
   */
  const inboundTimer = setInterval(() => {
    pollInboundSignals().catch((e: Error) => console.error('[inbound] poll failed:', e.message));
  }, Math.max(60_000, Math.floor(config.dataReview.sweepMs / 5)));
  inboundTimer.unref();

  const detectorTimer = setInterval(() => {
    runDetectors('schedule').catch((e: Error) =>
      console.error('[detectors] sweep failed:', e.message)
    );
  }, config.dataReview.sweepMs);
  detectorTimer.unref();

  /*
   * THE OPERATING RHYTHM. Fires every five minutes rather than at nine exact
   * local times, because a process that restarts at 8:44 must not miss the 8:45
   * huddle pack — the generator is idempotent per rhythm per business day, so
   * an extra tick costs a no-op and a missed one costs the meeting its pack.
   *
   * The same tick escalates review outputs that are open past their due time,
   * including on weekends: an output that came due on Friday afternoon was
   * overdue all weekend, and holding the escalation until Monday loses the one
   * signal that it slipped.
   */
  /*
   * MEETING REMINDERS. Every minute, because the 15-minute rep rung is the one
   * that matters most and a five-minute sweep would fire it at anywhere from 10
   * to 15 minutes out — which for the rung whose whole job is "you are about to
   * be late" is the difference between useful and noise.
   *
   * The gate runs per reminder at SEND time inside the dispatcher, not here: a
   * meeting booked Monday sends its 24-hour reminder Thursday, and consent can
   * be withdrawn in between.
   */
  const reminderTimer = setInterval(() => {
    dispatchDueReminders().catch((e: Error) => console.error('[reminders] dispatch failed:', e.message));
  }, 60_000);
  reminderTimer.unref();

  const rhythmTimer = setInterval(() => {
    runRhythm(new Date()).catch((e: Error) => console.error('[rhythm] tick failed:', e.message));
  }, 5 * 60_000);
  rhythmTimer.unref();

  const server = app.listen(PORT, () => {
    console.log(`LeadFlow API listening on port ${PORT} (${config.nodeEnv})`);
  });

  /**
   * Turn a listen failure into something actionable.
   *
   * Without this, a port clash surfaces as a raw `EADDRINUSE` stack trace from
   * deep inside Node's net module — which says nothing about what to do, and
   * under `ts-node-dev --respawn` repeats every few seconds. The commonest cause
   * by far is a previous dev server that was never stopped.
   */
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        [
          `[app] Port ${PORT} is already in use, so the LeadFlow API did not start.`,
          '',
          '      Almost always a dev server from an earlier session that is still running.',
          '      Find and stop it:',
          `        Windows:     netstat -ano | findstr :${PORT}`,
          '                     taskkill /PID <pid> /F',
          `        macOS/Linux: lsof -ti tcp:${PORT} | xargs kill`,
          '',
          '      Or start on a different port, pointing the client proxy at it too:',
          `        PORT=${PORT + 1} VITE_API_TARGET=http://localhost:${PORT + 1} npm run dev`,
        ].join('\n')
      );
      process.exit(1);
    }
    console.error(`[app] server error (${error.code ?? 'unknown'}):`, error.message);
    process.exit(1);
  });

  /** Drain in-flight requests and close the pool before exiting. */
  const shutdown = (signal: string): void => {
    console.log(`[app] ${signal} received, shutting down`);
    server.close(() => {
      void dataService.close().finally(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/*
 * ONLY WHEN THIS MODULE IS THE ENTRY POINT.
 *
 * bootstrap() runs migrations, seeds and provisioners — DDL and writes. Calling
 * it at module scope means merely IMPORTING app.ts provisions a database, so a
 * test that wanted the express app for one route assertion would silently
 * migrate whatever schema its environment happened to point at. Nothing imports
 * it that way today; this makes that stay true rather than remain a coincidence,
 * and it is what lets `export default app` be safe to consume.
 */
if (require.main === module) {
  bootstrap().catch((error: Error) => {
    console.error('[app] startup failed:', error.message);
    process.exit(1);
  });
}

export default app;
