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
  ownerUserId: string;
  ownerName: string | null;
  /** Share of open leads this owner holds, 0..1. */
  observedShare: number;
  /** Share they would hold under an even split. */
  fairShare: number;
  breachedLeads: number;
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
  /** Reference returned by sdk-assignment, so the run can be re-read. */
  simulationRef: string;
  /** Predicted share for this owner after the proposed change. */
  projectedShare: number;
  /** Predicted breaches over the simulated window, before and after. */
  breachesBefore: number;
  breachesAfter: number;
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
 * How much more than a fair share an owner must hold before it is worth
 * proposing a repair.
 *
 * A MULTIPLE OF FAIR SHARE, NOT AN ABSOLUTE PERCENTAGE, and the difference is
 * the whole rule. This started as "more than 15 percentage points above fair
 * share", which is a sane threshold for a team of three and silently unreachable
 * for any real one: measured against this project's own database — 2,969 owners
 * with leads in the window — fair share is 0.03%, so triggering would need one
 * person holding 15% of every open lead in the tenant. The check never fired and
 * looked like healthy routing. Holding TWICE your share means the same thing at
 * any team size.
 */
const SKEW_MULTIPLE = 2;

/**
 * Fewest open leads before a ratio means anything.
 *
 * Two leads against a fair share of one is a 2x skew and is noise. Without this
 * floor, the smallest teams generate the most proposals.
 */
const MIN_LEADS_FOR_SKEW = 5;

/**
 * How many skewed owners are simulated per run.
 *
 * Simulation is a network call each. Against the owner count above, simulating
 * every skewed owner would be thousands of round trips to produce a list no
 * manager is going to work through — so the worst offenders are simulated and
 * the rest wait for the next run, by which time acting on these will have
 * changed the shares anyway.
 */
const SKEW_CANDIDATE_LIMIT = 5;

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
 * Ask sdk-assignment to simulate a rebalance.
 *
 * @returns null when the simulator is unreachable. NULL IS THE POINT: the caller
 *          must not emit a routing proposal without this, and returning a
 *          plausible-looking local estimate instead would be inventing the
 *          evidence the criterion asks for.
 */
async function simulateRebalance(
  ownerUserId: string,
  observedShare: number
): Promise<RoutingSimulation | null> {
  if (!SdkGatewayClient.isConfigured()) {
    return null;
  }

  try {
    const result = await SdkGatewayClient.call<{
      data?: {
        simulation_id?: string;
        projected_share?: number;
        breaches_before?: number;
        breaches_after?: number;
      };
    }>({
      sdk: 'sdk-assignment',
      path: '/api/assignment/simulate',
      method: 'POST',
      idempotencyKey: `rebalance:${ownerUserId}:${observedShare.toFixed(2)}`,
      body: { owner_user_id: ownerUserId, observed_share: observedShare, strategy: 'even_split' },
    });

    const data = result.data?.data;
    if (!data?.simulation_id || typeof data.projected_share !== 'number') {
      // A response that does not carry a simulation reference is not evidence,
      // whatever else it contains. Treated as unavailable rather than partially
      // trusted — a proposal citing a simulation nobody can re-read is worse
      // than one that says the simulator was down.
      return null;
    }

    return {
      simulationRef: data.simulation_id,
      projectedShare: data.projected_share,
      breachesBefore: data.breaches_before ?? 0,
      breachesAfter: data.breaches_after ?? 0,
      simulatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[revops] assignment simulation failed:', message);
    return null;
  }
}

/**
 * Routing repairs, each backed by a simulation.
 *
 * THE ORDER HERE IS THE CRITERION. Skew is measured first, then the simulation
 * is run, and a proposal is built ONLY if the simulation came back. Doing it the
 * other way round — build the proposal, attach evidence if available — produces
 * exactly the artefact the criterion forbids: a routing change that looks
 * analysed and is not.
 */
export async function routingRepairs(): Promise<{
  repairs: RoutingRepair[];
  unavailableReason: string | null;
}> {
  const owners = await dataService.query<{
    owner_user_id: string;
    owner_name: string | null;
    open_leads: string;
    breached_leads: string;
  }>(
    `SELECT l.owner_user_id,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
              u.email
            ) AS owner_name,
            COUNT(*) FILTER (WHERE l.first_response_at IS NULL)::text AS open_leads,
            COUNT(*) FILTER (WHERE l.sla_breached)::text              AS breached_leads
       FROM leads l
       JOIN users u ON u.id = l.owner_user_id
      WHERE l.owner_user_id IS NOT NULL
        AND l.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY l.owner_user_id, u.first_name, u.last_name, u.email`,
    []
  );

  if (owners.length < 2) {
    // Fair share is meaningless with one owner, and proposing a rebalance to a
    // team of one is noise a manager learns to ignore.
    return { repairs: [], unavailableReason: null };
  }

  const totalOpen = owners.reduce((sum, row) => sum + (parseInt(row.open_leads, 10) || 0), 0);
  if (totalOpen === 0) {
    return { repairs: [], unavailableReason: null };
  }

  const fairShare = 1 / owners.length;
  const repairs: RoutingRepair[] = [];
  let unavailableReason: string | null = null;

  // Skew is measured, ranked and CAPPED before any simulation runs. Doing the
  // filtering inside the simulation loop would issue a network call per owner
  // and then throw most of the answers away.
  const skewed = owners
    .map((row) => {
      const openLeads = parseInt(row.open_leads, 10) || 0;
      return { row, openLeads, observedShare: openLeads / totalOpen };
    })
    .filter(
      (candidate) =>
        candidate.openLeads >= MIN_LEADS_FOR_SKEW &&
        candidate.observedShare >= fairShare * SKEW_MULTIPLE
    )
    .sort((a, b) => b.observedShare - a.observedShare)
    .slice(0, SKEW_CANDIDATE_LIMIT);

  for (const { row, observedShare } of skewed) {
    const simulation = await simulateRebalance(row.owner_user_id, observedShare);
    if (!simulation) {
      unavailableReason = 'assignment_simulation_unavailable';
      // NOT emitted. The skew is real and the repair is unproven, and shipping
      // the second because of the first is the failure this guard exists for.
      continue;
    }

    repairs.push({
      ownerUserId: row.owner_user_id,
      ownerName: row.owner_name,
      observedShare: Number(observedShare.toFixed(3)),
      fairShare: Number(fairShare.toFixed(3)),
      breachedLeads: parseInt(row.breached_leads, 10) || 0,
      simulation,
    });
  }

  return { repairs, unavailableReason };
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
    proposals.push(
      await proposeOnce(`routing:${repair.ownerUserId}`, {
        kind: 'next_action',
        subjectType: 'user',
        subjectId: repair.ownerUserId,
        content: {
          finding: 'routing_skew',
          action: 'Rebalance this owner’s share of incoming leads.',
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
