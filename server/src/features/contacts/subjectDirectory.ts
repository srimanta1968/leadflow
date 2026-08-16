import { dataService } from '../../services/DataService';

/**
 * Canonical person id → the contact this tenant knows under that id.
 *
 * WHY LOCAL AND NOT UPSTREAM. The obvious place to ask "what is this person
 * called" is ProjexCloud, and it cannot answer: `identity.alias` stores a hash
 * and an encrypted envelope by design, `projection.attribute_assertion` is empty
 * in every environment we have, and `/api/resolver/subjects/:id` — which this
 * codebase called for months — is in neither the router nor the manifest. The
 * only place a human name for these people exists is our own `leads` table.
 *
 * A MISS IS A RESULT, NOT A FAILURE. A consent register legitimately contains
 * subjects who are not LeadFlow leads: a receipt collected by another product in
 * the tenant, or a person whose lead was deleted. Those keep rendering as the
 * uuid, because inventing a label for a subject we cannot identify is the same
 * class of error as inventing a metric — and on a screen where the label decides
 * whose consent somebody is about to revoke, it is the more expensive one.
 */
export interface SubjectName {
  contact_id: string;
  name: string | null;
}

/**
 * Names for a batch of canonical person ids.
 *
 * ONE QUERY FOR THE PAGE, not one per row: the register renders up to 500 rows,
 * and a lookup per row is how a screen that reads fine in dev takes ten seconds
 * in production.
 *
 * @param personIds Canonical person ids, duplicates and nulls tolerated.
 * @returns A map keyed by person id. Ids with no local contact are ABSENT from
 *          the map rather than present with a null — "we do not know this
 *          person" and "we know them and they have no name" are different facts.
 */
export async function namesForPersons(
  personIds: (string | null | undefined)[]
): Promise<Map<string, SubjectName>> {
  const ids = [...new Set(personIds.filter((id): id is string => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return new Map();

  /*
   * DISTINCT ON keeps one contact per person id. Two leads can carry the same
   * canonical person while a candidate link is open — that is the state Identity
   * Review exists to settle — and a duplicate key here would make the map's
   * contents depend on row order. Newest wins, which is the one a steward
   * working today would recognise.
   */
  const rows = await dataService.query<{ canonical_person_id: string; id: string; name: string | null }>(
    `SELECT DISTINCT ON (canonical_person_id)
            canonical_person_id::text AS canonical_person_id,
            id::text AS id,
            name
       FROM leads
      WHERE canonical_person_id = ANY($1::uuid[])
      ORDER BY canonical_person_id, created_at DESC`,
    [ids]
  );

  const out = new Map<string, SubjectName>();
  for (const row of rows) {
    out.set(row.canonical_person_id, { contact_id: row.id, name: row.name });
  }
  return out;
}

/**
 * Record which canonical person a lead turned out to be.
 *
 * ONLY EVER CALLED WITH AN ID SOMETHING ASSERTED — an exact crosswalk upstream,
 * or a steward verifying a link. Never from a probabilistic match: writing the
 * likely id and letting the screen show a name would present a guess as a
 * finding, on the one screen whose job is to keep those apart.
 *
 * @returns The lead ids that now carry it — empty when the id was already there
 *          or the contact does not exist, which are both no-ops worth telling
 *          apart from an error.
 */
export async function linkContactToPerson(
  contactId: string,
  canonicalPersonId: string
): Promise<string[]> {
  const rows = await dataService.query<{ id: string }>(
    `UPDATE leads
        SET canonical_person_id = $2::uuid, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid
        AND (canonical_person_id IS NULL OR canonical_person_id <> $2::uuid)
      RETURNING id::text AS id`,
    [contactId, canonicalPersonId]
  );
  return rows.map((row) => row.id);
}
