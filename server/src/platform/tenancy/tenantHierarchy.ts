/**
 * How LeadFlow models one customer owning several apps.
 *
 * THE CONSTRAINT, from ProjexCloud's own guide (mcp-server/data/AGENTS.md):
 *
 *   "tenant.tenant.app_id is NOT NULL, so a tenant row belongs to exactly ONE
 *    app, while tenant.app_pool_index (jsonb app->pool) assumes several. To
 *    model one tenant owning several apps today, use the tenant hierarchy
 *    (parent_tenant_id / root_tenant_id): a root tenant per customer and a
 *    child tenant per app. Do not assume one tenant row can span apps."
 *
 * So "the tenant" is ambiguous and the ambiguity is expensive. Lynked-Up Pro as
 * a CUSTOMER is a root tenant; Lynked-Up Pro's LeadFlow instance is a CHILD
 * tenant of it, bound to the LeadFlow app_id. A second app they buy becomes a
 * second child, sibling to the first.
 *
 * WHY THIS FILE EXISTS BEFORE THE SECOND APP DOES. Today LeadFlow has one app,
 * so root and child collapse into the single tenant id in config and nothing
 * breaks. The moment a second app is sold, every row already written carries a
 * tenant_id that is now ambiguous — is it the customer or the app? — and no
 * amount of later code can tell which was meant. Deciding now costs a config
 * field; deciding later costs a migration over every tenant-scoped row in the
 * system, run against data whose meaning has to be guessed.
 */

import { config } from '../../config/env';

/** Which level of the hierarchy an id refers to. */
export type TenantScope =
  /** The CUSTOMER. Billing, contract, the org chart, cross-app reporting. */
  | 'root'
  /** ONE app for that customer. Where records actually live. */
  | 'app';

export interface TenantContext {
  /** The customer. Stable across every app they own. */
  rootTenantId: string;
  /**
   * The app-scoped tenant this process writes under. Equals rootTenantId while
   * the customer owns one app and the hierarchy has not been split.
   */
  appTenantId: string;
  /** The application this tenant row is bound to. */
  appId: string;
}

/**
 * Resolve the tenancy from configuration.
 *
 * `rootTenantId` falls back to the app tenant, which is correct for a
 * single-app customer and is the state every deployment starts in. Falling back
 * the OTHER way — defaulting the app tenant to the root — would be wrong the
 * moment a split happens, because writes would silently land on the customer
 * rather than on one of their apps.
 *
 * @param appTenantId  PROJEXCLOUD_TENANT_ID, the tenant records are written under.
 * @param appId        PROJEXCLOUD_APP_ID.
 * @param rootTenantId PROJEXCLOUD_ROOT_TENANT_ID, set once a customer has more
 *                     than one app.
 */
export function resolveTenantContext(
  appTenantId: string,
  appId: string,
  rootTenantId?: string
): TenantContext {
  return {
    appTenantId,
    appId,
    rootTenantId: rootTenantId && rootTenantId.length > 0 ? rootTenantId : appTenantId,
  };
}

/**
 * Which tenant id a given concern should be scoped to.
 *
 * The distinction is not cosmetic and gets it wrong in both directions:
 *
 *  - Scoping a LEAD to the root tenant leaks it between the customer's apps,
 *    so their recruitment product would see their sales pipeline.
 *  - Scoping BILLING to the app tenant fragments one customer into several
 *    payers, and they get an invoice per app they did not ask for.
 *
 * @param concern What is being scoped.
 */
export function tenantIdFor(
  context: TenantContext,
  concern:
    | 'lead'
    | 'routing'
    | 'sla'
    | 'audit'
    | 'consent'
    | 'billing'
    | 'org_chart'
    | 'cross_app_report'
): string {
  switch (concern) {
    // Operational records belong to ONE app. A lead captured in LeadFlow is not
    // visible to a sibling app, and that isolation is the point of the split.
    case 'lead':
    case 'routing':
    case 'sla':
    case 'consent':
      return context.appTenantId;

    // The audit chain follows the record it describes, so it is app-scoped too:
    // a cross-app ledger would let one app's operator read another's activity.
    case 'audit':
      return context.appTenantId;

    // The customer is the payer and the employer, once, however many apps.
    case 'billing':
    case 'org_chart':
    case 'cross_app_report':
      return context.rootTenantId;

    default:
      // An unrecognised concern gets the NARROWER scope. Guessing wide leaks
      // between apps; guessing narrow merely fails to find something.
      return context.appTenantId;
  }
}

/** True once the customer has been split into root plus per-app children. */
export function isHierarchySplit(context: TenantContext): boolean {
  return context.rootTenantId !== context.appTenantId;
}

/**
 * The context for this process, from the environment.
 *
 * Read per call rather than cached at module load so a test that overrides the
 * config sees it, and so a redeployment that sets the root tenant takes effect
 * without a code change.
 */
export function currentTenantContext(): TenantContext {
  return resolveTenantContext(
    config.projexCloud.tenantId,
    config.projexCloud.appId,
    config.projexCloud.rootTenantId
  );
}
