import { Pool, PoolClient, QueryResultRow } from 'pg';
import { databaseConfig } from '../config/database';

/**
 * The single gateway to PostgreSQL for the whole LeadFlow server.
 *
 * No controller, route or service opens its own connection — everything goes
 * through this class so pooling, parameter binding, transaction handling and
 * shutdown live in one place. Queries are always parameterised; string
 * interpolation into SQL is never permitted.
 *
 * LeadFlow owns only its 12 local tables (dashboard rollups, saved views,
 * stage config, template library, KPI definitions, outbox, and the session
 * projection). Contact, consent, assignment, SLA and audit data live in
 * ProjexCloud SDKs and are reached through the SDK gateway client, never here.
 */
export class DataService {
  private static instance: DataService | null = null;
  private readonly pool: Pool;

  private constructor() {
    this.pool = new Pool({
      host: databaseConfig.host,
      port: databaseConfig.port,
      database: databaseConfig.database,
      user: databaseConfig.user,
      password: databaseConfig.password,
      ssl: databaseConfig.ssl ? { rejectUnauthorized: false } : undefined,
      min: databaseConfig.pool.min,
      max: databaseConfig.pool.max,
    });

    this.pool.on('error', (err: Error) => {
      // An idle client failing must not take the process down.
      console.error('[DataService] idle client error:', err.message);
    });
  }

  /** Shared singleton — one pool per process. */
  static getInstance(): DataService {
    if (!DataService.instance) {
      DataService.instance = new DataService();
    }
    return DataService.instance;
  }

  /**
   * Run a parameterised query and return every row.
   * @param sql   SQL text using $1..$n placeholders.
   * @param params Values bound to the placeholders, in order.
   */
  async query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      const result = await this.pool.query<T>(sql, params);
      return result.rows;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[DataService] query failed:', message);
      throw error;
    }
  }

  /**
   * Run a parameterised query expected to match at most one row.
   * @returns The first row, or null when the query matched nothing.
   */
  async queryOne<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Run `work` inside a transaction, committing on success and rolling back on
   * any thrown error. The client is always released.
   */
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        const message =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        console.error('[DataService] rollback failed:', message);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Apply one migration and record it, atomically.
   *
   * DDL execution lives here rather than in the migration runner so that this
   * class stays the only module in the server that talks to the driver. The
   * statement and its bookkeeping row commit together, so a crash mid-migration
   * can never leave a migration recorded as applied when it was not.
   *
   * @param name Migration filename, used as the ledger key.
   * @param sql  The migration's full SQL text.
   */
  async applyMigration(name: string, sql: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO _leadflow_migrations (name) VALUES ($1)', [name]);
    });
  }

  /** True when the database answers a trivial query — used by /health. */
  async isHealthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /** Close the pool. Called on SIGTERM/SIGINT so in-flight queries drain. */
  async close(): Promise<void> {
    await this.pool.end();
    DataService.instance = null;
  }
}

export const dataService = DataService.getInstance();
