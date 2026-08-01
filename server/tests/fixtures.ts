import { dataService } from '../src/services/DataService';
import { LeadSourceChannel } from '../src/types';

/** A user created for a test. */
export interface UserFixture {
  id: string;
  email: string;
  displayName: string;
}

/** A lead created for a test, deliberately left unowned. */
export interface LeadFixture {
  id: string;
  email: string;
}

/**
 * Test fixtures.
 *
 * All fixture persistence lives here so test files describe BEHAVIOUR and never
 * carry SQL. Every statement goes through `DataService` — the same gateway the
 * application uses — so a fixture cannot drift from the real schema or open its
 * own connection.
 *
 * Shaped as a class with static methods to match the service layer's convention,
 * so the data-access pattern reads identically wherever it appears in the
 * codebase.
 *
 * These helpers run ONLY against the local test database. Nothing under `src/`
 * imports them.
 */
export class Fixtures {
  /** Unique suffix so repeated runs never collide on a unique column. */
  private static uniqueSuffix(): string {
    return `${Date.now()}.${Math.trunc(performance.now() * 1000)}`;
  }

  /**
   * Create an active user.
   * @param firstName Used in the display name so assertions read naturally.
   */
  static async createUser(firstName: string): Promise<UserFixture> {
    const email = `routing.${firstName.toLowerCase()}.${Fixtures.uniqueSuffix()}@leadflow.test`;
    try {
      const row = await dataService.queryOne<{ id: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [email, 'fixture-hash-never-used-for-login', firstName, 'Tester']
      );
      if (!row) {
        throw new Error('insert returned no row');
      }
      return { id: row.id, email, displayName: `${firstName} Tester` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`createUser('${firstName}') fixture failed: ${message}`);
    }
  }

  /**
   * Create a lead with no owner, bypassing intake auto-routing.
   *
   * Inserted directly rather than through `LeadCaptureService.capture` because
   * capture now routes at intake, and a routing test needs a lead that has not
   * been routed yet.
   */
  static async createUnownedLead(source: LeadSourceChannel): Promise<LeadFixture> {
    const email = `lead.${Fixtures.uniqueSuffix()}@leadflow.test`;
    try {
      const row = await dataService.queryOne<{ id: string }>(
        'INSERT INTO leads (name, email, source) VALUES ($1, $2, $3) RETURNING id',
        ['Routing Fixture', email, source]
      );
      if (!row) {
        throw new Error('insert returned no row');
      }
      return { id: row.id, email };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`createUnownedLead('${source}') fixture failed: ${message}`);
    }
  }

  /** Leave only the named users active, so round-robin has a known candidate set. */
  static async keepOnlyActive(userIds: string[]): Promise<void> {
    await dataService.query('UPDATE users SET is_active = $1 WHERE id <> ALL($2::uuid[])', [
      false,
      userIds,
    ]);
  }

  /** Deactivate one user, simulating someone leaving. */
  static async deactivateUser(userId: string): Promise<void> {
    await dataService.query('UPDATE users SET is_active = $1 WHERE id = $2', [false, userId]);
  }

  /** Deactivate every user, so routing has nobody to choose. */
  static async deactivateAllUsers(): Promise<void> {
    await dataService.query('UPDATE users SET is_active = $1 WHERE is_active = $2', [false, true]);
  }

  /** Reactivate everyone, so one test cannot starve the next. */
  static async reactivateAllUsers(): Promise<void> {
    await dataService.query('UPDATE users SET is_active = $1 WHERE is_active = $2', [true, false]);
  }

  /**
   * Park every currently-active routing rule and return their ids.
   *
   * Rules are long-lived configuration, so rules left by an earlier RUN of the
   * suite are still present on the next one. Two rules sharing an
   * `evaluation_order` tiebreak on `created_at`, so the older one wins and a
   * precedence assertion fails for reasons unrelated to the code under test.
   */
  static async parkActiveRules(): Promise<string[]> {
    const parked = await dataService.query<{ id: string }>(
      'UPDATE routing_rules SET is_active = $1 WHERE is_active = $2 RETURNING id',
      [false, true]
    );
    return parked.map((row) => row.id);
  }

  /**
   * Deactivate everything, then reactivate only the parked ids.
   *
   * Nothing is deleted: a routed lead holds `routing_rule_id` as a foreign key,
   * so removing the rule that routed it would either violate the constraint or
   * destroy the attribution that makes the decision explainable. Spent fixtures
   * remain as inactive rows, which the routing query filters out anyway.
   */
  static async restoreParkedRules(parkedIds: string[]): Promise<void> {
    await dataService.query('UPDATE routing_rules SET is_active = $1 WHERE is_active = $2', [
      false,
      true,
    ]);
    if (parkedIds.length > 0) {
      await dataService.query('UPDATE routing_rules SET is_active = $1 WHERE id = ANY($2::uuid[])', [
        true,
        parkedIds,
      ]);
    }
  }

  /**
   * Create a lead with an owner and a response clock positioned relative to now.
   *
   * Inserted directly so a test can place `sla_due_at` in the PAST, which the
   * application deliberately cannot do — there is no way to make a real clock
   * expire other than waiting thirty minutes for it.
   *
   * @param source        Capture channel.
   * @param ownerId       The owning user.
   * @param dueInMinutes  Minutes from now until the deadline. NEGATIVE for a clock
   *                      that has already expired.
   * @param windowMinutes Length of the whole response window, used to place
   *                      `assigned_at` so the at-risk fraction is meaningful.
   */
  static async createClockedLead(
    source: LeadSourceChannel,
    ownerId: string,
    dueInMinutes: number,
    windowMinutes = 30
  ): Promise<LeadFixture> {
    const email = `sla.${Fixtures.uniqueSuffix()}@leadflow.test`;
    const assignedOffset = dueInMinutes - windowMinutes;
    try {
      const row = await dataService.queryOne<{ id: string }>(
        `INSERT INTO leads (name, email, source, owner_user_id, assigned_at, sla_due_at,
                            routing_method, routing_reason, created_at)
         VALUES ($1, $2, $3, $4,
                 CURRENT_TIMESTAMP + ($5 || ' minutes')::interval,
                 CURRENT_TIMESTAMP + ($6 || ' minutes')::interval,
                 $7, $8,
                 CURRENT_TIMESTAMP + ($5 || ' minutes')::interval)
         RETURNING id`,
        [
          'SLA Fixture',
          email,
          source,
          ownerId,
          String(assignedOffset),
          String(dueInMinutes),
          'manual',
          'SLA monitoring fixture',
        ]
      );
      if (!row) {
        throw new Error('insert returned no row');
      }
      return { id: row.id, email };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`createClockedLead('${source}', ${dueInMinutes}) fixture failed: ${message}`);
    }
  }

  /** The lead's clock columns, for asserting what the monitor wrote. */
  static async clockOf(leadId: string): Promise<{
    first_response_at: Date | null;
    sla_breached: boolean;
    sla_breach_reason: string | null;
  } | null> {
    return dataService.queryOne(
      'SELECT first_response_at, sla_breached, sla_breach_reason FROM leads WHERE id = $1',
      [leadId]
    );
  }

  /** The single sla_metrics observation row for a lead, or null if none. */
  static async observationOf(leadId: string): Promise<{
    state: string | null;
    violation: boolean | null;
    response_seconds: number | null;
    response_time: string | null;
    target_minutes: number | null;
    clock_source: string | null;
    response_channel: string | null;
    responded_by_user_id: string | null;
    note: string | null;
  } | null> {
    return dataService.queryOne(
      `SELECT state, violation, response_seconds, response_time, target_minutes,
              clock_source, response_channel, responded_by_user_id, note
         FROM sla_metrics
        WHERE subject_lead_id = $1`,
      [leadId]
    );
  }

  /**
   * Park every currently-active SLA policy and return their ids.
   *
   * Policies are long-lived configuration, exactly like routing rules, so rows
   * left by an earlier RUN of the suite are still present on the next one and
   * would decide the match instead of the policy under test.
   */
  static async parkActivePolicies(): Promise<string[]> {
    const parked = await dataService.query<{ id: string }>(
      'UPDATE sla_policies SET is_active = $1 WHERE is_active = $2 RETURNING id',
      [false, true]
    );
    return parked.map((row) => row.id);
  }

  /**
   * Deactivate every policy, then reactivate only the parked ids.
   *
   * Nothing is deleted: a lead's sla_due_at was computed from the policy in force
   * when it was assigned, so removing the row would erase the explanation for
   * that deadline. Spent fixtures remain as inactive rows, which the matcher
   * filters out anyway.
   */
  static async restoreParkedPolicies(parkedIds: string[]): Promise<void> {
    await dataService.query('UPDATE sla_policies SET is_active = $1 WHERE is_active = $2', [
      false,
      true,
    ]);
    if (parkedIds.length > 0) {
      await dataService.query('UPDATE sla_policies SET is_active = $1 WHERE id = ANY($2::uuid[])', [
        true,
        parkedIds,
      ]);
    }
  }

  /**
   * Create an active user holding a named role.
   *
   * Breach escalation targets managers by `users.role`, and the default fixture
   * user is a plain 'user', so a test needs an explicit way to mint one.
   */
  static async createUserWithRole(firstName: string, role: string): Promise<UserFixture> {
    const email = `sla.${firstName.toLowerCase()}.${Fixtures.uniqueSuffix()}@leadflow.test`;
    try {
      const row = await dataService.queryOne<{ id: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [email, 'fixture-hash-never-used-for-login', firstName, 'Tester', role]
      );
      if (!row) {
        throw new Error('insert returned no row');
      }
      return { id: row.id, email, displayName: `${firstName} Tester` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`createUserWithRole('${firstName}', '${role}') fixture failed: ${message}`);
    }
  }

  /**
   * Park every currently-active manager by demoting them to 'user'.
   *
   * Breach escalation fans out to EVERY active manager, so managers left by an
   * earlier RUN of the suite would receive the alerts under test and make the
   * recipient assertions depend on the whole table. Returns the parked ids.
   */
  static async parkManagers(): Promise<string[]> {
    const parked = await dataService.query<{ id: string }>(
      "UPDATE users SET role = 'user' WHERE role = 'admin' RETURNING id",
      []
    );
    return parked.map((row) => row.id);
  }

  /** Demote every manager, then restore only the parked ids. */
  static async restoreParkedManagers(parkedIds: string[]): Promise<void> {
    await dataService.query("UPDATE users SET role = 'user' WHERE role = 'admin'", []);
    if (parkedIds.length > 0) {
      await dataService.query(
        "UPDATE users SET role = 'admin' WHERE id = ANY($1::uuid[])",
        [parkedIds]
      );
    }
  }

  /** Every alert raised for a lead, newest first. */
  static async alertsForLead(leadId: string): Promise<
    {
      id: string;
      recipient_user_id: string;
      kind: string;
      state: string;
      attempts: number;
      minutes_to_due: number | null;
      acknowledged_by_user_id: string | null;
    }[]
  > {
    return dataService.query(
      `SELECT id, recipient_user_id, kind, state, attempts, minutes_to_due,
              acknowledged_by_user_id
         FROM sla_alerts
        WHERE lead_id = $1
        ORDER BY raised_at DESC`,
      [leadId]
    );
  }

  /** True when the lead still has no owner. */
  static async isUnowned(leadId: string): Promise<boolean> {
    const row = await dataService.queryOne<{ owner_user_id: string | null }>(
      'SELECT owner_user_id FROM leads WHERE id = $1',
      [leadId]
    );
    return row !== null && row.owner_user_id === null;
  }

  /**
   * Create a lead at an EXPLICIT arrival time, with its outcome already decided.
   *
   * Every other lead fixture arrives "now", which is right for the operational
   * services but useless for analytics: those aggregate over a window, so a test
   * that wants to assert an exact count needs leads whose arrival time it chose.
   *
   * Placing them in a historical window is what makes exact assertions possible
   * at all. The analytics endpoint aggregates over EVERY lead in range, so a
   * test using "now" would be counting whatever else the database happens to
   * hold and could only ever assert deltas. A window years in the past is one no
   * real capture occupies, so the counts are the fixtures' alone.
   *
   * @param source        Capture channel.
   * @param createdAt     Arrival time — the instant analytics measures from.
   * @param options.ownerId          Owner, or omitted to leave the lead unrouted.
   * @param options.respondedAfterSeconds Seconds from arrival to the first human
   *                      response. Omitted leaves the clock open.
   * @param options.breached         Whether the clock is recorded as breached.
   */
  static async createHistoricalLead(
    source: LeadSourceChannel,
    createdAt: Date,
    options: {
      ownerId?: string;
      respondedAfterSeconds?: number;
      breached?: boolean;
    } = {}
  ): Promise<LeadFixture> {
    const email = `analytics.${Fixtures.uniqueSuffix()}@leadflow.test`;
    const respondedAt =
      options.respondedAfterSeconds === undefined
        ? null
        : new Date(createdAt.getTime() + options.respondedAfterSeconds * 1000);

    try {
      const row = await dataService.queryOne<{ id: string }>(
        `INSERT INTO leads (name, email, source, owner_user_id, assigned_at,
                            first_response_at, sla_breached, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          'Analytics Fixture',
          email,
          source,
          options.ownerId ?? null,
          options.ownerId ? createdAt : null,
          respondedAt,
          options.breached ?? false,
          createdAt,
        ]
      );
      if (!row) {
        throw new Error('insert returned no row');
      }
      return { id: row.id, email };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `createHistoricalLead('${source}', ${createdAt.toISOString()}) fixture failed: ${message}`
      );
    }
  }

  /** Remove leads created inside a window, so an analytics test cleans up after itself. */
  static async deleteLeadsInWindow(from: Date, to: Date): Promise<void> {
    await dataService.query(
      'DELETE FROM leads WHERE created_at >= $1 AND created_at < $2',
      [from, to]
    );
  }
}
