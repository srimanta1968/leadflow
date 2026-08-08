import { config } from '../../config/env';
import { SdkGatewayClient, upstreamStatusOf } from '../../platform/sdkGateway';

/**
 * Typed reads of the three SDKs the Import Center composes.
 *
 * EVERY READ DEGRADES ON ITS OWN. Each function answers `{ value, available }`
 * rather than throwing, so one SDK being down empties one panel instead of
 * failing the whole screen. The register is what the Import Center is FOR;
 * losing it because the connector service was restarting would be our fault
 * presented as somebody else's.
 *
 * `available: false` is NOT the same as an empty result and the two are never
 * collapsed. "There are no runs" and "we could not ask" look identical in a
 * bare array, and the difference is the entire content of the message the
 * screen needs to show.
 */

/** One import run, as sdk-import's `ImportRun` model returns it. */
export interface ImportRunRow {
  run_id?: string;
  status?: string;
  source_kind?: string;
  source_ref?: string | null;
  file_name?: string | null;
  row_count?: number | null;
  committed_row_count?: number | null;
  exception_count?: number;
  attestation_id?: string | null;
  rollback_deadline?: string | null;
  rolled_back_at?: string | null;
  quarantine_reason?: string | null;
  committed_at?: string | null;
  started_by?: string | null;
  correlation_id?: string;
  created_at?: string;
  mapping_template_id?: string | null;
  dry_run_result?: {
    governance?: GovernanceVerdict[];
    new_count?: number;
    exact_link_count?: number;
    review_case_count?: number;
    invalid_count?: number;
  } | null;
}

/** A single dry-run governance check, verbatim from sdk-import. */
export interface GovernanceVerdict {
  check?: string;
  passed?: boolean;
  detail?: string;
}

/** One row of created-entity lineage. */
export interface LineageRow {
  entity_kind?: string;
  entity_id?: string;
  action?: string;
  reversed_at?: string | null;
}

export interface MappingTemplateRow {
  template_id?: string;
  name?: string;
  kind?: string;
  version?: number;
  source_kind?: string | null;
  /** { "<source column>": { target, confidence, reason } } — one key per mapped field. */
  field_map?: Record<string, unknown> | null;
  transforms?: unknown[] | null;
  /** Incremented per committed run that used it: which mapping the tenant relies on. */
  use_count?: number | null;
  crosswalk_strategy?: string | null;
}

export interface ConnectorInstallRow {
  install_id?: string;
  kind?: string;
  status?: string;
  last_sync_at?: string | null;
}

/** What every read here answers: a value, and whether we could actually ask. */
export interface Reached<T> {
  value: T;
  available: boolean;
}

const unreachable = <T>(fallback: T): Reached<T> => ({ value: fallback, available: false });

/** The tenant every upstream read is scoped to, or undefined when unconfigured. */
export function tenantId(): string | undefined {
  return config.projexCloud.tenantId || undefined;
}

/**
 * One GET through the gateway, with the failure folded into the result.
 *
 * A THROW WOULD BE WRONG HERE. These are panels on a review screen, not writes;
 * the caller's job is to render what it could get and say what it could not,
 * and it cannot do that if the first failure unwinds the whole composition.
 */
async function read<T>(sdk: string, path: string, fallback: T, pick: (body: unknown) => T): Promise<Reached<T>> {
  if (!SdkGatewayClient.isConfigured()) {
    return unreachable(fallback);
  }
  try {
    const result = await SdkGatewayClient.call<{ data?: unknown }>({
      sdk,
      path,
      method: 'GET',
      body: undefined,
    });
    if (!result.delivered) {
      return unreachable(fallback);
    }
    return { value: pick(result.data?.data), available: true };
  } catch (error) {
    /*
     * AN UPSTREAM 404 IS AN ANSWER, NOT A FAILURE, and telling them apart is the
     * whole reason this wrapper exists.
     *
     * sdk-import saying "no such run" is the store working perfectly and
     * reporting an empty result. Folding that into `available: false` would make
     * a deleted import indistinguishable from an outage — the caller would
     * answer 200 "we could not reach the store" for a run that provably is not
     * there, and the operator would go looking for an incident that never
     * happened. So a 404 comes back ANSWERED and EMPTY, and the caller turns
     * that into its own 404.
     *
     * Note the gateway already separates a genuine record-level 404 from a
     * "route not mounted" 404 (see errorMapping) — the latter is a
     * misconfiguration and arrives as something other than 404 here, so it
     * correctly stays in the unreachable branch.
     */
    if (upstreamStatusOf(error) === 404) {
      return { value: fallback, available: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[imports] ${sdk} ${path} unavailable:`, message);
    return unreachable(fallback);
  }
}

/** Signals that sdk-import answered, and said there is no such run. */
export class ImportRunNotFound extends Error {
  constructor(runId: string) {
    super(`No import run with that id: ${runId}`);
    this.name = 'ImportRunNotFound';
  }
}

const q = (extra: Record<string, string | undefined> = {}): string => {
  const params = new URLSearchParams();
  const tenant = tenantId();
  if (tenant) {
    // sdk-import answers 400 without it — every one of its reads is tenant-scoped.
    params.set('tenant_id', tenant);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
};

const asArray = <T>(value: unknown, key: string): T[] => {
  const body = (value ?? {}) as Record<string, unknown>;
  return Array.isArray(body[key]) ? (body[key] as T[]) : [];
};

/** The run register. `limit` is the register's page, not the whole history. */
export function listRuns(limit = 100): Promise<Reached<ImportRunRow[]>> {
  return read(
    'sdk-import',
    `/api/imports/runs${q({ limit: String(limit) })}`,
    [] as ImportRunRow[],
    (body) => asArray<ImportRunRow>(body, 'runs'),
  );
}

/** The mapping-template library — certified and tenant-authored alike. */
export function listTemplates(): Promise<Reached<MappingTemplateRow[]>> {
  return read(
    'sdk-import',
    `/api/imports/mapping-templates${q()}`,
    [] as MappingTemplateRow[],
    (body) => asArray<MappingTemplateRow>(body, 'templates'),
  );
}

/**
 * Which connectors this tenant can import from.
 *
 * Returns empty AND unavailable when no tenant is configured, rather than
 * calling the endpoint with a blank tenant in the path — that would ask
 * sdk-connectors about a tenant literally named "undefined".
 */
export function listConnectors(): Promise<Reached<ConnectorInstallRow[]>> {
  const tenant = tenantId();
  if (!tenant) {
    return Promise.resolve(unreachable([] as ConnectorInstallRow[]));
  }
  return read(
    'sdk-connectors',
    `/api/connectors/tenants/${encodeURIComponent(tenant)}/installs`,
    [] as ConnectorInstallRow[],
    (body) => {
      const rows = asArray<ConnectorInstallRow>(body, 'installs');
      return rows.length > 0 || !Array.isArray(body) ? rows : (body as ConnectorInstallRow[]);
    },
  );
}

/**
 * Which connector KINDS exist at all, independent of what this tenant installed.
 *
 * SEPARATE FROM `listConnectors`, and the distinction is the whole of AC3. The
 * installs list answers "what can this tenant import from today"; the kinds list
 * answers "what does the product support". A source tile shown ONLY when it is
 * installed silently disappears for every tenant that has not connected it,
 * which reads as "we do not support Google Contacts" rather than "you have not
 * connected Google Contacts yet" — the opposite of what the operator needs to
 * know, since the second is a thing they can act on.
 */
export function listConnectorKinds(): Promise<Reached<ConnectorKindRow[]>> {
  return read(
    'sdk-connectors',
    '/api/connectors/kinds',
    [] as ConnectorKindRow[],
    (body) => {
      /*
       * sdk-connectors returns `data.kinds` as a BARE STRING ARRAY — the adapter
       * registry's keys — not as objects. Reading it as objects yields an array
       * of undefined `kind`s, which then silently filters to nothing and every
       * source tile reports "not connected" no matter what is installed. It was
       * doing exactly that until the shape was checked against the handler.
       */
      const raw = asArray<unknown>(body, 'kinds');
      return raw.map((entry) =>
        typeof entry === 'string' ? { kind: entry } : (entry as ConnectorKindRow),
      );
    },
  );
}

export interface ConnectorKindRow {
  kind?: string;
  label?: string;
  status?: string;
  available?: boolean;
}

/**
 * One run and its lineage, in the single call sdk-import already composes.
 *
 * `run: null` with `available: true` means sdk-import answered and has no such
 * run — the caller turns that into a 404. `available: false` means we never got
 * to ask, which is a 200 that says so. Those are different answers and this is
 * where the difference is preserved.
 */
export async function getRun(runId: string): Promise<Reached<{ run: ImportRunRow | null; lineage: LineageRow[] }>> {
  const result = await read(
    'sdk-import',
    `/api/imports/runs/${encodeURIComponent(runId)}${q()}`,
    { run: null as ImportRunRow | null, lineage: [] as LineageRow[] },
    (body) => {
      const payload = (body ?? {}) as { run?: ImportRunRow; lineage?: LineageRow[] };
      return {
        run: (payload.run ?? null) as ImportRunRow | null,
        lineage: Array.isArray(payload.lineage) ? payload.lineage : [],
      };
    },
  );
  return result;
}

/** The excepted rows for one run. Counted, not rendered — see the controller. */
export function listExceptions(runId: string): Promise<Reached<unknown[]>> {
  return read(
    'sdk-import',
    `/api/imports/runs/${encodeURIComponent(runId)}/exceptions${q()}`,
    [] as unknown[],
    (body) => asArray<unknown>(body, 'exceptions'),
  );
}

/** The rights attestation sworn for a run, by its id. */
export function getAttestation(attestationId: string): Promise<Reached<Record<string, unknown> | null>> {
  return read(
    'sdk-source-record',
    `/api/source-rights/attestations/${encodeURIComponent(attestationId)}${q()}`,
    null as Record<string, unknown> | null,
    (body) => (body ?? null) as Record<string, unknown> | null,
  );
}

/** What that attestation permits — the answer, not the paperwork. */
export function getPermittedUse(attestationId: string): Promise<Reached<Record<string, unknown> | null>> {
  return read(
    'sdk-source-record',
    `/api/source-rights/permitted-use${q({ attestation_id: attestationId })}`,
    null as Record<string, unknown> | null,
    (body) => (body ?? null) as Record<string, unknown> | null,
  );
}
