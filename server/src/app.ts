import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config/env';
import routes from './routes';
import { dataService } from './services/DataService';
import { runMigrations } from './db/migrationRunner';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

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
app.use(express.json({ limit: config.bodyLimit }));
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

bootstrap().catch((error: Error) => {
  console.error('[app] startup failed:', error.message);
  process.exit(1);
});

export default app;
