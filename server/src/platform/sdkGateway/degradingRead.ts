import { SdkGatewayClient } from './client';
import { upstreamStatusOf } from './errorMapping';

/**
 * The read shape every composed screen needs from ProjexCloud.
 *
 * A screen that composes several SDKs has to answer a question a bare value
 * cannot: did we get an empty result, or did we fail to ask? Those look
 * identical in an empty array and the difference is the entire content of the
 * message the operator needs to see — "there is nothing here" versus "we could
 * not find out". Collapsing them turns an outage into a clean, wrong answer.
 *
 * This lived inside the Import Center's gateway first. It is here because the
 * Identity Review screen needs exactly the same guarantees, and a second copy
 * would be two chances to get the 404 rule below subtly different.
 */

/** A value, and whether we could actually ask for it. */
export interface Reached<T> {
  value: T;
  available: boolean;
}

/** An answer we could not obtain, carrying the caller's chosen empty value. */
export const unreachable = <T>(fallback: T): Reached<T> => ({ value: fallback, available: false });

/**
 * Read one upstream collection, degrading rather than throwing.
 *
 * @param sdk      SDK package name, for the circuit and the health panel.
 * @param path     Upstream path, query string included.
 * @param fallback What `value` carries when the read does not land.
 * @param pick     Projects the upstream `data` envelope into the caller's shape.
 * @returns The value and whether the read reached a working service.
 */
export async function degradingRead<T>(
  sdk: string,
  path: string,
  fallback: T,
  pick: (body: unknown) => T
): Promise<Reached<T>> {
  if (!SdkGatewayClient.isConfigured()) {
    return unreachable(fallback);
  }

  try {
    const result = await SdkGatewayClient.call<{ data?: unknown }>({
      sdk,
      path,
      method: 'GET',
    });
    if (!result.delivered) {
      return unreachable(fallback);
    }
    return { value: pick(result.data?.data), available: true };
  } catch (error) {
    /*
     * AN UPSTREAM 404 IS AN ANSWER, NOT A FAILURE, and telling them apart is
     * the whole reason this wrapper exists.
     *
     * The service saying "no such thing" is the service working perfectly and
     * reporting an empty result. Folding that into `available: false` would
     * make a record that provably is not there indistinguishable from an
     * outage, and send an operator looking for an incident that never
     * happened. So a 404 comes back ANSWERED and EMPTY, and the caller decides
     * what that means for its own status code.
     *
     * The gateway already separates a record-level 404 from a "route not
     * mounted" 404 (see errorMapping) — the latter is a misconfiguration and
     * arrives as something other than 404, so it correctly stays unreachable.
     */
    if (upstreamStatusOf(error) === 404) {
      return { value: fallback, available: true };
    }
    return unreachable(fallback);
  }
}
