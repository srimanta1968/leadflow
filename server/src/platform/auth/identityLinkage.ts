import { dataService } from '../../services/DataService';
import type { PlatformSession } from './sessionContext';

/**
 * Bind a local user row to the platform identity layers it belongs to.
 *
 * WHY THIS EXISTS: the columns were already there and nothing wrote them.
 * `007_persona_identity` added `platform_person_id`, `platform_persona_id` and
 * `platform_tenant_id` to `users`, plus persona columns across leads, routing
 * rules and SLA rows — and an audit found NOTHING populating any of them. The
 * architecture was present in the migration and absent in the running system,
 * which is worse than not having it: the schema claims a linkage that no query
 * can rely on, so the next author either trusts an empty column or adds a
 * fourth one beside it.
 *
 * THE LAYERS, and which of them a local row may hold (ProjexCloud architecture
 * section 7):
 *
 *   L1 person_id             the human, globally. One row per real person
 *                            across every app and tenant.
 *   L2 app_identity_id       that person inside ONE application.
 *   L3 tenant_membership_id  that identity inside ONE tenant — and the layer
 *                            that CARRIES tenant-scoped roles.
 *   L4 persona_id            the hat worn here. Everything downstream keys on
 *                            it, which is why it is on the data rows and not
 *                            only on `users`.
 *
 * LeadFlow persists L1, L3's tenant and L4 today. L2 and the membership id
 * itself are not yet modelled — see the handoff. They are additive: nothing
 * here has to change to gain them, which is the point of writing the linkage
 * down now rather than after a second app exists.
 *
 * WRITES ONLY WHAT IT LEARNS, and never overwrites with null. A request whose
 * token names no persona must not erase a persona recorded by an earlier
 * request that did — losing a linkage is silent and permanent, and the row
 * afterwards looks exactly like one that was never linked.
 */
export async function linkPlatformIdentity(
  userId: string,
  session: PlatformSession
): Promise<void> {
  if (!userId) return;

  /*
   * COALESCE on the EXCLUDED side, so a null in this session leaves whatever is
   * already stored intact. Written as a single statement rather than a
   * read-then-write: two concurrent requests for the same user would otherwise
   * race, and the loser would write back the value it read before the winner
   * updated it.
   */
  await dataService.query(
    `UPDATE users
        SET platform_person_id  = COALESCE($2::uuid, platform_person_id),
            platform_persona_id = COALESCE($3::uuid, platform_persona_id),
            platform_tenant_id  = COALESCE($4::uuid, platform_tenant_id)
      WHERE id = $1
        AND (platform_person_id  IS DISTINCT FROM COALESCE($2::uuid, platform_person_id)
          OR platform_persona_id IS DISTINCT FROM COALESCE($3::uuid, platform_persona_id)
          OR platform_tenant_id  IS DISTINCT FROM COALESCE($4::uuid, platform_tenant_id))`,
    [
      userId,
      session.personId || null,
      session.personaId || null,
      session.tenantId || null,
    ]
  );
}

/**
 * The persona to stamp on a row this request creates or claims.
 *
 * @returns The acting persona, or null when the caller has no platform session.
 *          NULL IS HONEST: a local-only session has no persona, and inventing
 *          one — the user id, say — would put a value in a persona column that
 *          no upstream lookup can resolve, which is worse than an empty column
 *          because it looks populated.
 */
export function actingPersonaId(session: PlatformSession | undefined): string | null {
  return session?.personaId ?? null;
}
