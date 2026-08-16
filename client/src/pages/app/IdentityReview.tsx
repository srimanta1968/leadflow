import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, IdentityReviewCase, IdentityReviewQueue } from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';
import { failureFor } from '../../content/messages';
import { chipClass, riskChipClass } from '../../design-system/tokens';
import { IdentityCandidateModal } from '../../components/app/IdentityCandidateModal';

/**
 * Identity Review — #view-identity, "Link-Over-Merge Stewardship".
 *
 * ONE FETCH FOR THE WHOLE SCREEN. The server composes the queue and the tiles
 * from the same instant, so a headline count can never disagree with the rows
 * beneath it.
 *
 * THE SCREEN NEVER OFFERS A MERGE. Every action here verifies or retracts a
 * LINK, because a merge cannot be undone even in principle — once two source
 * records are collapsed, which assertion came from which is gone. A link keeps
 * both, which is why a verified link can be retracted and the projections
 * replayed. That is the whole premise of the epic and it has to be visible on
 * the screen, not just true in the backend.
 */

const BAND_FILTERS = [
  { key: '', label: 'All risk' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
] as const;

/** A tile value that has no upstream metric, rendered so nobody reads it as zero. */
function GapValue({ reason }: { reason: string }) {
  return (
    <span className="text-soft" title={reason}>
      Not measured
    </span>
  );
}

/** One side of a candidate pair: the local name if we hold one, the id always. */
function SubjectCell({
  personId,
  subject,
}: {
  personId: string | null;
  subject: { name: string | null; contact_id: string } | null;
}) {
  return (
    <td className="py-2">
      {subject?.name ? <div>{subject.name}</div> : null}
      <div className="text-soft font-mono text-xs">{personId ?? '—'}</div>
      {!subject && (
        <div className="text-soft text-xs">No contact in this workspace</div>
      )}
    </td>
  );
}

export default function IdentityReview() {
  const [data, setData] = useState<IdentityReviewQueue | null>(null);
  const [band, setBand] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<IdentityReviewCase | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { notify } = useToast();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .identityReviewQueue(band || undefined)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          notify(failureFor(error instanceof ApiError ? error.code : 'INTERNAL_ERROR'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [band, notify, reloadKey]);

  const gapFor = useMemo(() => {
    const map = new Map((data?.metric_gaps ?? []).map((gap) => [gap.metric, gap.reason]));
    return (metric: string) => map.get(metric) ?? 'No upstream metric.';
  }, [data]);

  const slaMinutes = data?.sla?.review_minutes ?? 15;
  const breached = (data?.cases ?? []).filter((row) => row.sla_breached === true).length;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Identity Review</h1>
        <p className="text-soft max-w-3xl">
          Link-over-merge stewardship. Every case here is a possible match the resolver
          would not link on its own. Destructive merge is unavailable — a link can be
          verified or retracted, and source rows stay intact either way.
        </p>
      </header>

      {/* The six-tile rail. Three are live; three say plainly that they are not. */}
      <section className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Tile label="Review Cases" caption={`${data?.kpis?.review_cases.high_risk ?? 0} high risk`}>
          {data?.kpis?.review_cases.total ?? 0}
        </Tile>
        <Tile label="Exact Auto-Links" caption="Crosswalk or deterministic exact match">
          <GapValue reason={gapFor('exact_auto_links')} />
        </Tile>
        <Tile label="Kept Separate" caption="This month">
          <GapValue reason={gapFor('kept_separate')} />
        </Tile>
        <Tile label="Retracted Links" caption="Replayed downstream projections">
          {data?.kpis?.retracted_links ?? 0}
        </Tile>
        <Tile label="Median Review" caption={`Within ${slaMinutes}-minute SLA`}>
          <GapValue reason={gapFor('median_review_minutes')} />
        </Tile>
        <Tile label="Resolver Calibration" caption="High-risk precision benchmark">
          {data?.kpis?.resolver_calibration
            ? `ECE ${(data.kpis.resolver_calibration.ece ?? 0).toFixed(3)}`
            : <GapValue reason="EMPI metrics could not be reached." />}
        </Tile>
      </section>

      <section className="flex flex-wrap items-center gap-2">
        {BAND_FILTERS.map((filter) => (
          <button
            key={filter.key || 'all'}
            type="button"
            onClick={() => setBand(filter.key)}
            className={`rounded-full border px-3 py-1 text-sm ${
              band === filter.key ? 'border-brand text-brand' : 'border-line text-soft'
            }`}
          >
            {filter.label}
          </button>
        ))}
        {breached > 0 && (
          <span className={`rounded-full border px-3 py-1 text-sm ${chipClass('blocked')}`}>
            {breached} past the {slaMinutes}-minute review SLA
          </span>
        )}
      </section>

      <section>
        <table className="w-full text-left text-sm">
          <thead className="text-soft">
            <tr>
              <th className="py-2">Risk</th>
              <th>Source record</th>
              <th>Candidate canonical contact</th>
              <th>Model score</th>
              <th>Age</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {(data?.cases ?? []).map((row) => (
              <tr
                key={row.link_id ?? `${row.person_id_a}-${row.person_id_b}`}
                /* AC3 — a breached case is escalated visually, not only counted. */
                className={row.sla_breached ? 'border-l-2 border-red' : undefined}
              >
                <td className="py-2">
                  <span className={`rounded-full border px-2 py-0.5 ${riskChipClass(row.risk_band)}`}>
                    {row.risk_band}
                  </span>
                </td>
                {/*
                  A NAME WHERE WE HAVE ONE, THE ID ALWAYS. The steward is being
                  asked whether two records are the same human, and was shown two
                  uuids to decide it with. The id stays underneath because it is
                  what the modal, the decision call and every upstream service
                  quote back — and because a case whose sides we cannot name is
                  one they should be able to see is unnamed.
                */}
                <SubjectCell personId={row.person_id_a} subject={row.subject_a} />
                <SubjectCell personId={row.person_id_b} subject={row.subject_b} />
                <td>
                  {row.model_score.toFixed(2)}{' '}
                  <span className="text-soft">not auto-linkable</span>
                </td>
                <td>
                  {row.age_minutes === null ? (
                    <span className="text-soft" title="This case carries no readable timestamp.">
                      Unknown
                    </span>
                  ) : (
                    <span className={row.sla_breached ? 'text-red' : undefined}>
                      {row.age_minutes}m
                    </span>
                  )}
                </td>
                <td>
                  <button type="button" className="text-brand" onClick={() => setOpen(row)}>
                    Compare
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && (data?.cases ?? []).length === 0 && (
          <p className="text-soft py-6">
            {/*
              One stem, two endings. An empty queue and an unreachable resolver are
              different facts and the screen says which — an operator who reads
              "nothing to review" during an outage stops looking.
            */}
            No cases to review —{' '}
            {data?.upstream_available?.candidate_links === false
              ? 'could not reach the identity resolver, so the queue is unavailable rather than empty.'
              : 'nothing is waiting on a steward decision.'}
          </p>
        )}
      </section>

      {open && (
        <IdentityCandidateModal
          candidate={open}
          onClose={() => setOpen(null)}
          onDecided={() => setReloadKey((n) => n + 1)}
        />
      )}
    </div>
  );
}

function Tile({
  label,
  caption,
  children,
}: {
  label: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-line rounded-lg border p-4">
      <div className="text-soft text-xs uppercase tracking-wide">{label}</div>
      <div className="py-1 text-xl font-semibold">{children}</div>
      <div className="text-soft text-xs">{caption}</div>
    </div>
  );
}
