import {
  PromptTemplate,
  promptTemplateByKey,
  allPromptTemplateKeys,
} from '../../config/promptTemplates';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';
import { AppError, ErrorCodes } from '../../utils/errors';

/**
 * Resolution and rendering of the versioned prompt library.
 *
 * WHERE THE ACTIVE VERSION COMES FROM. sdk-taxonomy publishes the templates and
 * decides which version is active; `config/promptTemplates.ts` is the version
 * this build was written and tested against. The taxonomy wins when it is
 * reachable — otherwise publishing centrally would achieve nothing — and the
 * pinned version is used when it is not.
 *
 * WHY FALLING BACK IS SAFE HERE, when the kill switch next door does the
 * opposite. The pinned template is not an assumption about an unknown state; it
 * is APPROVED COPY that shipped in this build. Halting generation because a
 * catalogue service is briefly down would take an outage in a non-critical
 * dependency and turn it into a product outage, and the thing we would be
 * protecting against is using copy that was approved slightly less recently. The
 * kill switch is the opposite case: there, not knowing is the risk.
 */

export interface ResolvedTemplate extends PromptTemplate {
  /** Where the active version came from. Stamped into the completion ledger. */
  source: 'taxonomy' | 'pinned';
}

/**
 * How long a taxonomy answer is trusted.
 *
 * Long, because a template activation is a deliberate publishing act that
 * happens on the order of weeks, and re-reading the catalogue on every
 * completion would put a second network hop in front of every token for a value
 * that almost never changes.
 */
const TAXONOMY_TTL_MS = 600_000;

const cache = new Map<string, { template: ResolvedTemplate; readAt: number }>();

/** Drop cached taxonomy reads. For tests and for a forced re-read after publishing. */
export function resetPromptLibraryCache(): void {
  cache.clear();
}

/**
 * Resolve one template by key.
 *
 * @throws AppError(422 PROMPT_TEMPLATE_NOT_PERMITTED) for a key not in the library.
 */
export async function resolveTemplate(key: string): Promise<ResolvedTemplate> {
  const pinned = promptTemplateByKey(key);
  if (!pinned) {
    // REFUSED, not passed through as free text. A key the library does not know
    // is a request to send a prompt nobody approved, and answering it would make
    // the library advisory.
    throw new AppError(
      422,
      ErrorCodes.PROMPT_TEMPLATE_NOT_PERMITTED,
      `No approved prompt template is registered under '${key}'. Registered: ${allPromptTemplateKeys().join(', ')}`
    );
  }

  const hit = cache.get(key);
  if (hit && Date.now() - hit.readAt < TAXONOMY_TTL_MS) {
    return hit.template;
  }

  if (!SdkGatewayClient.isConfigured()) {
    return { ...pinned, source: 'pinned' };
  }

  try {
    const result = await SdkGatewayClient.call<{
      data?: { templates?: { key?: string; version?: string; body?: string; slots?: string[] }[] };
    }>({
      sdk: 'sdk-taxonomy',
      path: '/api/taxonomy/prompt-templates',
      method: 'GET',
    });

    const published = result.data?.data?.templates?.find((entry) => entry.key === key);
    if (!published?.version) {
      // The taxonomy answered and does not carry this template. The pinned copy
      // stands — it is approved copy, and refusing here would mean a template
      // that has not yet been published centrally cannot be used at all.
      const resolved: ResolvedTemplate = { ...pinned, source: 'pinned' };
      cache.set(key, { template: resolved, readAt: Date.now() });
      return resolved;
    }

    const resolved: ResolvedTemplate = {
      ...pinned,
      version: published.version,
      body: published.body ?? pinned.body,
      // The SLOT LIST STAYS PINNED unless the taxonomy declares one. Taking an
      // absent slot list as "no slots" would make rendering refuse every
      // variable the template actually needs.
      slots: published.slots ?? pinned.slots,
      source: 'taxonomy',
    };
    cache.set(key, { template: resolved, readAt: Date.now() });
    return resolved;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[promptLibrary] taxonomy unreachable, using pinned '${key}':`, message);
    return { ...pinned, source: 'pinned' };
  }
}

/**
 * Render a template against a slot map.
 *
 * REFUSES AN UNDECLARED SLOT, and refuses a declared slot that was not supplied.
 * The first is how prose sneaks into an approved template; the second leaves a
 * literal `{first_name}` in a message a rep might not read closely before
 * accepting it.
 */
export function renderTemplate(
  template: PromptTemplate,
  slots: Record<string, string>
): string {
  const declared = new Set(template.slots);
  const supplied = Object.keys(slots);

  const undeclared = supplied.filter((name) => !declared.has(name));
  const missing = template.slots.filter((name) => !(name in slots));

  if (undeclared.length > 0 || missing.length > 0) {
    const parts: string[] = [];
    if (undeclared.length > 0) {
      parts.push(`slots not declared by '${template.key}': ${undeclared.join(', ')}`);
    }
    if (missing.length > 0) {
      parts.push(`required slots not supplied: ${missing.join(', ')}`);
    }
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, parts.join('; '));
  }

  let rendered = template.body;
  for (const [name, value] of Object.entries(slots)) {
    // Split/join rather than a RegExp: a slot value containing `$&` or `$1`
    // would otherwise be interpreted as a replacement pattern, which is both a
    // corruption and a way to inject text that never appeared in the input.
    rendered = rendered.split(`{${name}}`).join(value);
  }
  return rendered;
}
