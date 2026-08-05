import { dataService } from '../../services/DataService';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';
import { propose, proposalById, Proposal } from '../../platform/ai/reviewGate';

/**
 * The AI RevOps module: findings about how the machine is running.
 *
 * Three kinds of finding, and they are deliberately different in what they are
 * allowed to do without help:
 *
 *  - DUPLICATES the deterministic resolver missed. Computed locally from the
 *    canonical columns, because near-duplicate detection needs no simulation to
 *    be reviewable — the evidence is the two rows.
 *  - ROUTING REPAIRS from observed fair-share skew. These are NOT emitted
 *    without simulation evidence. See `routingRepairs`.
 *  - SEQUENCE STEPS with a poor reply-to-annoyance ratio, from what the local
 *    projection can see about responses and suppressions.
 *
 * EVERY FINDING BECOMES A PROPOSAL through the shared human-review gate rather
 * than being applied. That is not a courtesy: a module that could merge two
 * records or rewrite a routing rule on its own would be making irreversible
 * decisions about somebody's data on the strength of a heuristic.
 */

export interface DuplicateCandidate {
  leftLeadId: string;
  rightLeadId: string;
  /** Which canonical column matched. */
  matchedOn: 'canonical_email' | 'canonical_phone' | 'canonical_social_id';
  matchedValue: string;
  /** Why the deterministic resolver did not already merge these. */
  whyMissed: string;
}

export interface RoutingRepair {
  personaId: string;
  /** 'over_allocated' or 'starved' — the two have different causes and fixes. */
  kind: 'over_allocated' | 'starved' | 'received_nothing';
  /** Assignments this persona took under the candidate rules. */
  count: number;
  /** How far from the mean, as a multiple. 1.0 is exactly average. */
  ratio: number;
  /** Mean assignments per persona, so the ratio can be read against something. */
  mean: number;
  /**
   * The simulation that backs this proposal.
   *
   * NON-OPTIONAL BY TYPE. A routing repair without simulation evidence is not a
   * weaker proposal, it is a different thing entirely — an opinion about how
   * work should be split, dressed as an analysis. Making the field required
   * means the only way to emit one is to have actually run the simulation.
   */
  simulation: RoutingSimulation;
}

export interface RoutingSimulation {
  /**
   * The RUN, not the rules — assignment.simulation_run is immutable, so a
   * reviewer can re-open these exact numbers months later. candidate_version
   * identifies the RULES, and two runs of one version over different windows are
   * different evidence with the same version number.
   */
  simulationRef: string;
  candidateVersion: number;
  subjectsReplayed: number;
  /**
   * SLA outcome projection, when sdk-assignment has a projector wired.
   *
   * ABSENT MEANS NOT PROJECTED AND MUST NOT BE READ AS "NO CHANGE". There is
   * deliberately no breaches_before/breaches_after on the upstream report, and
   * the upstream says why: a rule set that distributes perfectly evenly can
   * breach MORE, because a breach is a function of the clock, the calendar and
   * the policy on each subject — none of which the replay reads. This field
   * carries the projection when it exists and stays undefined otherwise; the
   * old local breachesBefore/breachesAfter pair was inferred from distribution
   * and has been deleted rather than left to imply a claim nobody can support.
   */
  slaProjection?: unknown;
  simulatedAt: string;
}

export interface SequenceFinding {
  stepKey: string;
  sent: number;
  replied: number;
  suppressed: number;
  /**
   * Replies per suppression.
   *
   * The ratio rather than either count alone: a step with four replies and forty
   * opt-outs is not a good step that happens to be busy, and a raw reply count
   * says it is.
   */
  replyToAnnoyance: number;
  verdict: string;
}

export interface RevOpsReport {
  duplicates: DuplicateCandidate[];
  routingRepairs: RoutingRepair[];
  /**
   * Why no routing repair was proposed, when none was.
   *
   * Present precisely BECAUSE the empty list is otherwise ambiguous: "routing is
   * healthy" and "we could not check" look identical, and only one of them means
   * the manager can stop looking.
   */
  routingUnavailableReason: string | null;
  sequenceFindings: SequenceFinding[];
  /** Proposals opened for human review, one per finding. */
  proposals: Proposal[];
  generatedAt: string;
}

/**
 * How far from the mean counts as skewed, passed to sdk-assignment.
 *
 * THE SKEW MATHS USED TO LIVE HERE and no longer does. LeadFlow derived its own
 * fair-share rule — first an absolute 15-point gap, then a 2x multiple after the
 * first version turned out to be unreachable on a real team — while
 * sdk-assignment had been computing exactly this all along and returning it as
 * `skew` on the simulate report. Two definitions of "skewed" over one dataset
 * drift, and the local one was strictly worse: it could see over-allocation and
 * was structurally blind to STARVATION, because counting who holds too much
 * never surfaces the person holding nothing.
 *
 * 0.5 means 50% above or below the mean. Sent as skew_tolerance so the threshold
 * is stated in the request rather than reimplemented in the reader.
 */
const SKEW_TOLERANCE = 0.5;

/**
 * How many historical decisions the replay covers.
 *
 * The upstream default is the last 200. A wider window is a better sample and a
 * slower call; this is the compromise, and it is stated here rather than left to
 * the default so a change is visible in the diff.
 */
const REPLAY_LIMIT = 500;

/**
 * Near-duplicates the canonical resolver did not merge.
 *
 * Looks for rows sharing a canonical value that are NOT already linked. The
 * canonical columns exist because the dedupe gate normalises on write, so a
 * shared canonical value with two surviving rows means the two arrived through
 * paths that did not compare — a webhook and a manual capture, most often.
 */
export async function duplicateCandidates(limit = 25): Promise<DuplicateCandidate[]> {
  const candidates: DuplicateCandidate[] = [];

  // One straightforward self-join per canonical column rather than one clever
  // UNION over all three. Three small queries a reader can check beat one nobody
  // will correct, and `b.id > a.id` is what stops each pair appearing twice with
  // the sides swapped.
  //
  // The column name is interpolated and that is safe HERE and nowhere near a
  // request: `columns` is this module's own literal array, never caller input.
  const columns: DuplicateCandidate['matchedOn'][] = [
    'canonical_email',
    'canonical_phone',
    'canonical_social_id',
  ];

  for (const column of columns) {
    const pairs = await dataService.query<{
      left_id: string;
      right_id: string;
      matched_value: string;
      left_source: string | null;
      right_source: string | null;
    }>(
      `SELECT a.id AS left_id,
              b.id AS right_id,
              a.${column} AS matched_value,
              a.source AS left_source,
              b.source AS right_source
         FROM leads a
         JOIN leads b
           ON b.${column} = a.${column}
          AND b.id > a.id
        WHERE a.${column} IS NOT NULL
        ORDER BY a.created_at DESC
        LIMIT $1`,
      [limit]
    );

    for (const pair of pairs) {
      candidates.push({
        leftLeadId: pair.left_id,
        rightLeadId: pair.right_id,
        matchedOn: column,
        matchedValue: pair.matched_value,
        whyMissed:
          pair.left_source === pair.right_source
            ? `Both arrived through ${pair.left_source ?? 'an unrecorded source'}, so the dedupe gate compared them and still let both survive — worth a steward's eye.`
            : `Arrived through different paths (${pair.left_source ?? 'unknown'} and ${pair.right_source ?? 'unknown'}), which is the usual reason the write-time gate never compared them.`,
      });
    }
  }

  return candidates.slice(0, limit);
}

/**
 * The rule set version currently ACTIVE for this tenant.
 *
 * READ, NOT ASSUMED. This started as a hardcoded `candidate_version: 1`, which
 * is a guess that fails silently in the worst way: if the tenant's active rule
 * set is version 3, replaying against version 1 compares what actually happened
 * against RULES THAT ARE NO LONGER IN FORCE, and the skew audit then describes a
 * distribution nobody is operating. The proposal would look evidenced and be
 * about the wrong thing.
 *
 * @returns null when no rule set is active — which means there is nothing to
 *          replay against, not that version 1 will do.
 */
async function activeRuleSetVersion(): Promise<number | null> {
  try {
    const result = await SdkGatewayClient.call<{
      data?: { versions?: Array<{ version?: number; is_active?: boolean }> };
    }>({
      sdk: 'sdk-assignment',
      path: '/api/assignment/routes',
      method: 'GET',
    });

    const active = result.data?.data?.versions?.find((entry) => entry.is_active === true);
    return typeof active?.version === 'number' ? active.version : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[revops] could not read the active rule set version:', message);
    return null;
  }
}

/** The candidate personas a replay is run against, from our own owned leads. */
async function candidatePersonaIds(): Promise<string[]> {
  const rows = await dataService.query<{ owner_persona_id: string }>(
    `SELECT DISTINCT owner_persona_id
       FROM leads
      WHERE owner_persona_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '30 days'`,
    []
  );
  return rows.map((row) => row.owner_persona_id);
}

/**
 * Replay recent routing decisions through sdk-assignment and take its skew audit.
 *
 * ONE CALL FOR THE WHOLE TENANT, not one per owner. The previous version derived
 * skew locally and then simulated the worst few offenders individually, which was
 * both a network call per owner and a second opinion about who was skewed.
 * sdk-assignment computes the audit over the whole replay, so the answer and the
 * evidence come from the same place.
 *
 * @returns null when the simulator is unreachable OR has nothing to replay. NULL
 *          IS THE POINT: the caller must not emit a routing proposal without
 *          this, and returning a plausible local estimate would be inventing the
 *          evidence the criterion asks for.
 */
async function replayForSkew(): Promise<{
  simulation: RoutingSimulation;
  skew: {
    mean: number;
    over_allocated: Array<{ persona_id: string; count: number; ratio: number }>;
    starved: Array<{ persona_id: string; count: number; ratio: number }>;
    received_nothing: string[];
  };
} | null> {
  if (!SdkGatewayClient.isConfigured()) {
    return null;
  }

  const [candidates, candidateVersion] = await Promise.all([
    candidatePersonaIds(),
    activeRuleSetVersion(),
  ]);

  if (candidates.length < 2) {
    // Skew across fewer than two personas is not a concept, and the endpoint
    // requires a non-empty candidate list anyway.
    return null;
  }

  if (candidateVersion === null) {
    // No active rule set means there is nothing meaningful to replay against.
    // Falling back to a version number would produce an audit of a distribution
    // nobody is operating, which is worse than no audit.
    return null;
  }

  try {
    const result = await SdkGatewayClient.call<{
      data?: {
        simulation_id?: string;
        candidate_version?: number;
        subjects_replayed?: number;
        skew?: {
          mean: number;
          over_allocated: Array<{ persona_id: string; count: number; ratio: number }>;
          starved: Array<{ persona_id: string; count: number; ratio: number }>;
          received_nothing: string[];
        };
        sla_projection?: unknown;
      };
    }>({
      sdk: 'sdk-assignment',
      path: '/api/assignment/simulate',
      method: 'POST',
      idempotencyKey: `revops-skew:${candidateVersion}:${candidates.length}:${REPLAY_LIMIT}`,
      body: {
        // Replaying the CURRENTLY ACTIVE rules against the recorded decisions,
        // which is what makes the report describe the distribution we actually
        // have rather than one a hypothetical rule change would produce.
        candidate_version: candidateVersion,
        candidate_persona_ids: candidates,
        skew_tolerance: SKEW_TOLERANCE,
        limit: REPLAY_LIMIT,
      },
    });

    const data = result.data?.data;
    // A response with no run id is not evidence, whatever else it contains: a
    // proposal citing a simulation nobody can re-open is worse than one that
    // says the simulator was down. Same for a replay of nothing — zero subjects
    // produces a skew audit over an empty set, which is not a finding.
    if (!data?.simulation_id || !data.skew || !data.subjects_replayed) {
      return null;
    }

    return {
      simulation: {
        simulationRef: data.simulation_id,
        candidateVersion: data.candidate_version ?? candidateVersion,
        subjectsReplayed: data.subjects_replayed,
        // Carried through UNTOUCHED when present, absent when not. Absent means
        // not projected, never "no change" — see the field docs.
        slaProjection: data.sla_projection,
        simulatedAt: new Date().toISOString(),
      },
      skew: data.skew,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[revops] assignment simulation failed:', message);
    return null;
  }
}

export async function routingRepairs(): Promise<{
  repairs: RoutingRepair[];
  unavailableReason: string | null;
}> {
  // NO LOCAL SKEW MATHS. The whole owners-and-fair-share query that used to open
  // this function is gone: sdk-assignment computes the audit over its own replay
  // and returns it, so asking it is both the answer and the evidence. Deriving a
  // second opinion here and then simulating to "confirm" it was two definitions
  // of skewed over one dataset, and the local one could not see starvation at
  // all.
  const replay = await replayForSkew();

  if (!replay) {
    // Distinguishable from "routing is healthy", which is the whole reason this
    // field exists: an empty list with no reason reads as all-clear.
    return { repairs: [], unavailableReason: 'assignment_simulation_unavailable' };
  }

  const { simulation, skew } = replay;
  const repairs: RoutingRepair[] = [];

  for (const row of skew.over_allocated) {
    repairs.push({
      personaId: row.persona_id,
      kind: 'over_allocated',
      count: row.count,
      ratio: Number(row.ratio.toFixed(3)),
      mean: Number(skew.mean.toFixed(3)),
      simulation,
    });
  }

  // STARVATION IS REPORTED SEPARATELY, and this is the capability the local
  // version never had. Over-allocation and starvation have different causes and
  // different fixes, and a single "imbalance" number hides the person who got
  // nothing — which is the case a manager most wants to know about, because it
  // is usually a rule that stopped matching rather than a workload problem.
  for (const row of skew.starved) {
    repairs.push({
      personaId: row.persona_id,
      kind: 'starved',
      count: row.count,
      ratio: Number(row.ratio.toFixed(3)),
      mean: Number(skew.mean.toFixed(3)),
      simulation,
    });
  }

  for (const personaId of skew.received_nothing) {
    repairs.push({
      personaId,
      kind: 'received_nothing',
      count: 0,
      ratio: 0,
      mean: Number(skew.mean.toFixed(3)),
      simulation,
    });
  }

  return { repairs, unavailableReason: null };
}

/**
 * Sequence steps whose replies do not justify their opt-outs.
 *
 * Read from what the local projection actually holds — responses and
 * suppression-shaped signals per capture channel — rather than from a sequence
 * engine LeadFlow does not own. The step key is therefore the channel, and the
 * finding says so instead of implying a per-message breakdown it cannot produce.
 */
export async function sequenceFindings(): Promise<SequenceFinding[]> {
  const rows = await dataService.query<{
    step_key: string | null;
    sent: string;
    replied: string;
    suppressed: string;
  }>(
    `SELECT l.source AS step_key,
            COUNT(*)::text                                                AS sent,
            COUNT(*) FILTER (WHERE l.first_response_at IS NOT NULL)::text AS replied,
            COUNT(*) FILTER (WHERE l.sla_breached)::text                  AS suppressed
       FROM leads l
      WHERE l.created_at >= NOW() - INTERVAL '30 days'
        AND l.source IS NOT NULL
      GROUP BY l.source
     HAVING COUNT(*) >= 5`,
    []
  );

  return rows
    .map((row) => {
      const sent = parseInt(row.sent, 10) || 0;
      const replied = parseInt(row.replied, 10) || 0;
      const suppressed = parseInt(row.suppressed, 10) || 0;
      // Divide by suppressed-or-one so a channel with no opt-outs reports its
      // reply count rather than Infinity, which sorts first and means nothing.
      const ratio = Number((replied / Math.max(1, suppressed)).toFixed(2));

      return {
        stepKey: row.step_key ?? 'unattributed',
        sent,
        replied,
        suppressed,
        replyToAnnoyance: ratio,
        verdict:
          ratio < 1
            ? 'More leads went unanswered past their deadline than replied. Worth retiring or rewriting before it is sent again.'
            : 'Replies outweigh the misses on this channel.',
      };
    })
    .filter((finding) => finding.replyToAnnoyance < 1)
    .sort((a, b) => a.replyToAnnoyance - b.replyToAnnoyance);
}

/**
 * Open a proposal for a finding, or return the one already waiting for it.
 *
 * WITHOUT THIS THE ANALYSIS IS NOT SAFE TO RE-RUN, and re-running is the whole
 * point of exposing it as a GET. The same duplicate pair is still a duplicate
 * pair five minutes later; proposing it again gives a steward the same decision
 * twice and a queue that grows every time anybody refreshes the screen. Observed
 * rather than predicted: the first live call against the development database
 * opened a proposal per sequence finding, and a second call opened them all
 * again.
 *
 * The key is matched against OPEN proposals only. A finding whose proposal was
 * rejected and which is still true SHOULD come back — that is a steward saying
 * "not now" rather than "never", and suppressing it forever would quietly turn
 * one rejection into a permanent blind spot.
 */
async function proposeOnce(
  dedupeKey: string,
  input: { kind: 'next_action'; subjectType?: string; subjectId?: string; content: Record<string, unknown> }
): Promise<Proposal> {
  const existing = await dataService.queryOne<{ id: string }>(
    `SELECT id FROM ai_proposal
      WHERE status = 'proposed'
        AND agent_key = 'revops_analyst'
        AND content->>'dedupeKey' = $1
      LIMIT 1`,
    [dedupeKey]
  );

  if (existing) {
    const open = await proposalById(existing.id);
    if (open) {
      return open;
    }
  }

  return propose({
    agentKey: 'revops_analyst',
    kind: input.kind,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    content: { ...input.content, dedupeKey },
  });
}

/**
 * Run the RevOps analysis and open a proposal per finding.
 *
 * Each finding goes through the shared gate as a `next_action` — what a RevOps
 * finding actually is, once you strip the analysis off it, is a proposed piece
 * of work with evidence attached. Nothing here applies anything.
 *
 * SAFE TO RE-RUN: every proposal is keyed on the finding it came from, so a
 * second call returns the proposals already waiting rather than opening a second
 * copy of each.
 */
export async function revopsAnalysis(): Promise<RevOpsReport> {
  const [duplicates, routing, sequences] = await Promise.all([
    duplicateCandidates(),
    routingRepairs(),
    sequenceFindings(),
  ]);

  const proposals: Proposal[] = [];

  for (const duplicate of duplicates) {
    proposals.push(
      // Keyed on the PAIR, not on the left row: the same two records are one
      // decision however many canonical columns they happen to share.
      await proposeOnce(`duplicate:${duplicate.leftLeadId}:${duplicate.rightLeadId}`, {
        kind: 'next_action',
        subjectType: 'lead',
        subjectId: duplicate.leftLeadId,
        content: {
          finding: 'duplicate_candidate',
          action: 'Review these two records and merge or reject the link.',
          evidence: duplicate,
        },
      })
    );
  }

  for (const repair of routing.repairs) {
    // Keyed on persona AND kind: one persona can legitimately be both starved
    // under the current rules and named in received_nothing, and those are two
    // decisions rather than one duplicate.
    proposals.push(
      await proposeOnce(`routing:${repair.kind}:${repair.personaId}`, {
        kind: 'next_action',
        // The subject is a PERSONA now, not a local user row. sdk-assignment
        // reasons in personas, and mapping its answer back onto a users.id would
        // reintroduce exactly the local re-derivation this change removed.
        subjectType: 'persona',
        content: {
          finding: 'routing_skew',
          action:
            repair.kind === 'over_allocated'
              ? 'Rebalance this persona’s share of incoming work.'
              : repair.kind === 'starved'
                ? 'This persona is taking materially less than the mean — check the rules still match them.'
                : 'This persona received NOTHING under the current rules, which is usually a rule that stopped matching rather than a workload problem.',
          // The simulation travels ON the proposal, so a reviewer reading it
          // months later sees the evidence rather than a claim that some
          // evidence once existed.
          evidence: repair,
        },
      })
    );
  }

  for (const finding of sequences) {
    proposals.push(
      await proposeOnce(`sequence:${finding.stepKey}`, {
        kind: 'next_action',
        content: {
          finding: 'sequence_quality',
          action: `Review the ${finding.stepKey} channel: ${finding.verdict}`,
          evidence: finding,
        },
      })
    );
  }

  return {
    duplicates,
    routingRepairs: routing.repairs,
    routingUnavailableReason: routing.unavailableReason,
    sequenceFindings: sequences,
    proposals,
    generatedAt: new Date().toISOString(),
  };
}
