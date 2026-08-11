import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type ContactProvenance } from '../../../services/api';
import { useContactRecord } from '../ContactRecordContext';
import { AssertionTable } from '../../../design-system/evidence/AssertionTable';
import type { Assertion } from '../../../design-system/evidence/assertions';
import { useToast } from '../../../components/feedback/ToastProvider';

/**
 * Contact 360 Data & Provenance (#c-provenance).
 *
 * CONFLICTING VALUES COEXIST. The framing line is the design: a Google display
 * name can SURVIVE while a licensed-third-party phone is SUPERSEDED and a
 * public-record legal owner name sits alongside both as an ASSERTION, all on one
 * person, all still visible. The ordinary CRM behaviour — last writer wins,
 * previous value gone — is what makes a data dispute unanswerable six months
 * later, because the losing value and the reason it lost were both discarded at
 * the moment they became interesting.
 *
 * A SUPERSEDED ROW CARRIES THE REASON IT LOST, and that is enforced in the TYPE
 * rather than here (see design-system/evidence/assertions.ts): the Superseded
 * arm of the union REQUIRES `supersededReason`, so a row that says "Superseded"
 * and nothing else does not compile. The mapping below is therefore where the
 * server's nullable field has to be reconciled with that guarantee, and a
 * missing reason is reported in place of the reason rather than dropped.
 *
 * REVEALING A MASKED VALUE IS ITSELF A GOVERNED ACTION. The reveal goes through
 * the vault and is audited with the actor and the purpose; a UI that decrypted
 * locally would make the audit trail a record of what the server was asked for
 * rather than of what a person actually saw.
 */

const FRAMING =
  'Conflicting source values coexist; the display projection is explained, not silently overwritten.';

export default function ProvenanceTab() {
  const { contactId } = useContactRecord();
  const [data, setData] = useState<ContactProvenance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { notify } = useToast();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        setData(await api.contactProvenance(contactId, controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(caught instanceof ApiError ? caught.message : 'Provenance could not be read.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [contactId]);

  /**
   * Server rows -> the typed Assertion union.
   *
   * The server's `superseded_reason` is nullable and the type's is not, which is
   * the check doing its job: rather than widen the type, a row that lost without
   * saying why is rendered as having lost without a recorded reason. That is a
   * visible defect on screen, which is the point — silently dropping it would
   * leave an operator believing the survivorship engine had explained itself.
   */
  const assertions = useMemo<Assertion[]>(
    () =>
      (data?.assertions ?? []).map((row): Assertion => {
        const base = {
          id: row.assertion_id,
          assertion: row.assertion,
          value: row.value,
          source: row.source ?? row.origin_class ?? 'Unknown source',
          crosswalkRef: row.crosswalk_ref ?? undefined,
          originClass: row.origin_class ?? 'unknown',
          confidence: row.confidence,
          effectiveAt: row.effective_at,
          retrievedAt: row.retrieved_at,
          evidenceRef: row.evidence_ref ?? undefined,
          sensitive: row.sensitive,
        };

        if (row.status === 'Superseded') {
          return {
            ...base,
            status: 'Superseded',
            supersededReason:
              row.superseded_reason && row.superseded_reason.trim() !== ''
                ? row.superseded_reason
                : 'No reason was recorded for this supersession.',
          };
        }
        return { ...base, status: row.status };
      }),
    [data],
  );

  return (
    <section aria-label="Data and Provenance">
      <div className="lf-panel p-5">
        <h2 className="text-lg font-semibold text-text">Data &amp; Provenance</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">{FRAMING}</p>
      </div>

      <div className="lf-panel mt-4 p-5">
        {error && (
          <p className="mb-3 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
            {error}
          </p>
        )}

        <AssertionTable
          rows={assertions}
          loading={loading}
          onOpenEvidence={(assertion) => {
            // The reveal is an audited governed action performed by the server.
            // Naming the purpose here is what the audit entry records; a reveal
            // with no stated purpose is not auditable after the fact.
            notify({
              tone: 'info',
              title: 'Reveal is an audited action',
              detail: `Revealing ${assertion.assertion} records your identity and the stated purpose in the audit chain.`,
            });
          }}
        />
      </div>
    </section>
  );
}
