import { dataService } from '../../services/DataService';
import { AT_RISK_THRESHOLD } from '../../services/SlaMonitorService';

/**
 * The AI Manager module: predict a breach before it happens.
 *
 * WHY THIS EXISTS ALONGSIDE THE DETERMINISTIC AT-RISK FLAG, which is the whole
 * point of the module and the thing to understand before changing anything here.
 * `SlaMonitorService` turns a lead amber at `AT_RISK_THRESHOLD` — 0.8 of the
 * window, six minutes of a thirty-minute clock. That is a fact about ONE lead's
 * elapsed time and it arrives at T+24, which is a warning a manager can rarely
 * act on: by then the rep who was going to answer has either answered or is not
 * at their desk.
 *
 * This module predicts the same breach at T+15 by using signals the elapsed-time
 * rule does not have — how deep the owner's queue is, whether the lead has an
 * owner at all, and whether that owner is responding to anything today. Those
 * are properties of the QUEUE, not of the lead, and they are what actually
 * determine whether somebody gets to it.
 *
 * EVERY PREDICTION CARRIES ITS EVIDENCE AND A CONFIDENCE BAND. A risk score a
 * manager cannot interrogate is a number they will either over-trust or ignore,
 * and the second is what happens once it is wrong twice. So each signal reports
 * what it observed, what it contributed, and why — and the band widens when the
 * prediction rests on thin evidence rather than pretending to a precision the
 * inputs do not support.
 *
 * DETERMINISTIC, NOT A MODEL CALL. Two reasons, the same two as the SDR scorer:
 * a manager watching a lead move from 62 to 71 with nothing changed stops
 * believing any of it, and the criterion asks for evidence per signal, which a
 * language model can only narrate after the fact.
 */

/**
 * Minutes of warning a manager needs for the intervention to be worth making.
 *
 * FIFTEEN, and it is the number in the criterion rather than a tuning knob
 * somebody picked. Below this there is no time to find the rep, check whether
 * they are on a call, and reassign — so a signal that fires later is not an
 * early warning, it is a notification of something already lost.
 */
export const INTERVENTION_LEAD_MINUTES = 15;

/**
 * Predicted-risk level at which a signal is raised.
 *
 * Deliberately below the 0.8 elapsed-time threshold in composite terms: the
 * point is to fire while `SlaMonitorService` still says on_track. Set it higher
 * and this module tells managers what the amber flag already told them.
 */
const RAISE_AT_RISK = 0.55;

/** How many signals one call returns before it stops being actionable. */
const SIGNAL_LIMIT = 50;

export interface RiskEvidence {
  /** Stable signal key. */
  signal: string;
  /** What was actually observed, in the manager's terms. */
  observed: string;
  /** Contribution to the composite risk, 0..1. */
  contribution: number;
  /** Why this signal predicts a breach. */
  because: string;
}

export interface RiskSignal {
  leadId: string;
  leadName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  /** Minutes since the clock started. */
  elapsedMinutes: number;
  /** The response window in minutes. */
  targetMinutes: number;
  /** Minutes left before the deadline. Negative is excluded — see below. */
  minutesRemaining: number;
  /** Composite predicted risk, 0..1. */
  risk: number;
  /**
   * Lower and upper bound on `risk`.
   *
   * Widens when the prediction rests on fewer signals. A point estimate implies
   * a precision the inputs do not have, and a manager who learns the number is
   * over-confident stops using the screen.
   */
  confidence: { low: number; high: number };
  evidence: RiskEvidence[];
  /**
   * True when there is still enough time to do something about it.
   *
   * The criterion is not "predicts a breach" — a prediction delivered at T+29 is
   * accurate and useless. This field is the criterion in the response.
   */
  interventionWindowOpen: boolean;
  /** What the deterministic elapsed-time rule says right now, for contrast. */
  deterministicState: 'on_track' | 'at_risk';
}

interface OpenLeadRow {
  id: string;
  name: string | null;
  created_at: Date;
  assigned_at: Date | null;
  sla_due_at: Date;
  owner_user_id: string | null;
  owner_name: string | null;
  /** Unanswered leads this owner is currently holding, this one included. */
  owner_open_leads: string;
  /** Responses this owner has recorded in the last 24 hours. */
  owner_recent_responses: string;
}

/**
 * Every lead whose clock is still running, with its owner's live load.
 *
 * The load counts are computed in the SAME query rather than per row: a manager
 * screen refreshed on every push event would otherwise issue one lookup per
 * lead, and the whole point of the module is that it is cheap enough to run
 * continuously.
 */
const OPEN_LEADS_SQL = `
  SELECT l.id,
         l.name,
         l.created_at,
         l.assigned_at,
         l.sla_due_at,
         l.owner_user_id,
         COALESCE(
           NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
           u.email
         ) AS owner_name,
         COALESCE(load.open_leads, 0)::text       AS owner_open_leads,
         COALESCE(recent.responses, 0)::text      AS owner_recent_responses
    FROM leads l
    LEFT JOIN users u ON u.id = l.owner_user_id
    LEFT JOIN (
      SELECT owner_user_id, COUNT(*) AS open_leads
        FROM leads
       WHERE first_response_at IS NULL
         AND sla_due_at IS NOT NULL
         AND owner_user_id IS NOT NULL
       GROUP BY owner_user_id
    ) load ON load.owner_user_id = l.owner_user_id
    LEFT JOIN (
      SELECT owner_user_id, COUNT(*) AS responses
        FROM leads
       WHERE first_response_at >= NOW() - INTERVAL '24 hours'
         AND owner_user_id IS NOT NULL
       GROUP BY owner_user_id
    ) recent ON recent.owner_user_id = l.owner_user_id
   WHERE l.first_response_at IS NULL
     AND l.sla_due_at IS NOT NULL
     AND l.sla_breached = FALSE
     -- PAST-DUE CLOCKS ARE EXCLUDED IN THE QUERY, not in the loop, and the
     -- difference is not cosmetic. Ordering by sla_due_at ascending puts the
     -- oldest deadlines first, so on any database with history the LIMIT fills
     -- entirely with clocks that expired weeks ago; the loop then discards
     -- every one of them and the module returns nothing while dozens of
     -- actionable leads sit just outside the window. Filtering here means the
     -- rows fetched are the most urgent FUTURE deadlines, which is what the
     -- ordering was for.
     AND l.sla_due_at > NOW()
   ORDER BY l.sla_due_at ASC
   LIMIT $1`;

/**
 * The queue-depth signal.
 *
 * A rep holding one unanswered lead will get to it. A rep holding twelve will
 * not get to all twelve inside thirty minutes, and which one slips is decided by
 * whichever they happen to open — so depth predicts a breach that elapsed time
 * cannot see yet.
 */
function queueDepthSignal(openLeads: number): RiskEvidence {
  // Saturates at eight. Beyond that the rep is equally overloaded and a linear
  // scale would let one extreme queue dominate the composite entirely.
  const contribution = Math.min(1, Math.max(0, (openLeads - 1) / 7)) * 0.4;
  return {
    signal: 'queue_depth',
    observed: `${openLeads} unanswered lead${openLeads === 1 ? '' : 's'} on this owner`,
    contribution: Number(contribution.toFixed(3)),
    because:
      openLeads <= 1
        ? 'A single open lead gets worked. Depth is not what will cause this breach.'
        : 'Every additional unanswered lead is another one competing for the same half hour, and which one slips is decided by whichever the rep opens first.',
  };
}

/**
 * The coverage signal.
 *
 * An unowned lead has nobody whose problem it is. This is the single strongest
 * predictor in the set and it is invisible to an elapsed-time rule, which
 * happily reports a fully on-track clock on a lead no human has ever seen.
 */
function coverageSignal(ownerUserId: string | null): RiskEvidence {
  const covered = ownerUserId !== null;
  return {
    signal: 'coverage',
    observed: covered ? 'Owner assigned' : 'No owner assigned',
    // SIZED TO CROSS THE RAISE THRESHOLD ON ITS OWN, deliberately, and written
    // as the constant rather than as a number that happens to equal it so the
    // two cannot drift apart. An unanswered lead with a deep queue MIGHT still
    // get worked; one with nobody accountable will not, unless somebody happens
    // to look. So an unowned lead with a live clock is always surfaced — it is
    // the single most actionable thing on the list and the exact gap the
    // elapsed-time rule has.
    contribution: covered ? 0 : RAISE_AT_RISK,
    because: covered
      ? 'Somebody is accountable for this clock.'
      : 'Nobody is accountable for this clock. An elapsed-time rule reports it as on_track right up to the deadline, because the only thing it measures is the passage of time.',
  };
}

/**
 * The rep-activity signal.
 *
 * An owner who has answered nothing in twenty-four hours is, as far as this
 * system can tell, not working the queue today — on leave, in the field, or
 * simply not looking. LeadFlow holds no presence service, so this is an
 * INFERENCE from the record and it says so: the wording avoids claiming the rep
 * is absent, because a rep who has been on one long call all morning is present
 * and would be described identically.
 */
function repActivitySignal(ownerUserId: string | null, recentResponses: number): RiskEvidence {
  if (ownerUserId === null) {
    return {
      signal: 'rep_activity',
      observed: 'No owner, so no activity to read',
      contribution: 0,
      because: 'Already counted by the coverage signal; counting it twice would double the weight of one fact.',
    };
  }

  const quiet = recentResponses === 0;
  return {
    signal: 'rep_activity',
    observed: `${recentResponses} response${recentResponses === 1 ? '' : 's'} recorded by this owner in 24 hours`,
    contribution: quiet ? 0.2 : 0,
    because: quiet
      ? 'This owner has recorded nothing in a day. That may mean absent, or it may mean one long call — LeadFlow holds no presence service, so this is read from the record rather than known.'
      : 'This owner is working the queue today.',
  };
}

/** The elapsed-time signal, which is what the deterministic rule already sees. */
function elapsedSignal(fraction: number): RiskEvidence {
  // Weighted LOW on purpose. Elapsed time is the signal the amber flag already
  // provides at 0.8, and leaning on it here would just reproduce that flag a few
  // minutes early rather than predicting from the queue.
  const contribution = Math.min(1, Math.max(0, fraction)) * 0.15;
  return {
    signal: 'elapsed_fraction',
    observed: `${Math.round(fraction * 100)}% of the response window has passed`,
    contribution: Number(contribution.toFixed(3)),
    because:
      'Included for completeness and weighted lowest of the four: this is the one signal the deterministic at-risk flag already has, and the module exists to fire before that flag does.',
  };
}

/**
 * The confidence band.
 *
 * Width is driven by HOW MANY signals actually contributed, not by the score. A
 * prediction resting on one contributing signal is a guess with a number
 * attached; one where three agree is worth acting on, and the band should say
 * which of those a manager is looking at.
 */
function confidenceBand(risk: number, contributing: number): { low: number; high: number } {
  const width = contributing >= 3 ? 0.08 : contributing === 2 ? 0.15 : 0.25;
  return {
    low: Number(Math.max(0, risk - width).toFixed(3)),
    high: Number(Math.min(1, risk + width).toFixed(3)),
  };
}

export interface RiskSignalQuery {
  /** Only signals with at least this much warning left. Defaults to the criterion. */
  minLeadMinutes?: number;
  /** Evaluation instant. Injected so every lead in one call is judged alike. */
  now?: Date;
  limit?: number;
}

export interface RiskSignalReport {
  signals: RiskSignal[];
  /** The lead time the report was filtered on. */
  interventionLeadMinutes: number;
  /**
   * Open clocks examined, so an empty signal list is distinguishable from an
   * empty queue. "Nothing is at risk" and "nothing is being measured" look
   * identical otherwise, and only one of them is good news.
   */
  openClocksExamined: number;
  /** Where the deterministic rule would have raised its own flag, for contrast. */
  deterministicAtRiskFraction: number;
  generatedAt: string;
}

/**
 * Predict which open clocks will breach, early enough to act.
 *
 * A BREACHED LEAD IS NOT A PREDICTION and is excluded at the query. Reporting
 * one would inflate the module's apparent accuracy with facts, and a manager
 * scanning for what to intervene on would have to sort the past out of the list
 * every time.
 */
export async function riskSignals(query: RiskSignalQuery = {}): Promise<RiskSignalReport> {
  const now = query.now ?? new Date();
  const minLead = query.minLeadMinutes ?? INTERVENTION_LEAD_MINUTES;
  const limit = Math.min(Math.max(1, query.limit ?? SIGNAL_LIMIT), 200);

  const rows = await dataService.query<OpenLeadRow>(OPEN_LEADS_SQL, [limit]);
  const signals: RiskSignal[] = [];

  for (const row of rows) {
    const startedAt = (row.assigned_at ?? row.created_at).getTime();
    const dueAt = row.sla_due_at.getTime();
    const window = dueAt - startedAt;

    if (window <= 0) {
      // A due date at or before the clock start is a data problem, not a
      // prediction. Skipped rather than reported as certain-breach, which would
      // put a broken row at the top of the manager's list every refresh.
      continue;
    }

    const elapsed = now.getTime() - startedAt;
    const fraction = elapsed / window;
    const minutesRemaining = Math.round((dueAt - now.getTime()) / 60000);

    // Already past the deadline: history, not a forecast. The sweep records it
    // as a breach; this module does not compete with that.
    if (minutesRemaining <= 0) {
      continue;
    }

    const openLeads = parseInt(row.owner_open_leads, 10) || 0;
    const recentResponses = parseInt(row.owner_recent_responses, 10) || 0;

    const evidence = [
      coverageSignal(row.owner_user_id),
      queueDepthSignal(openLeads),
      repActivitySignal(row.owner_user_id, recentResponses),
      elapsedSignal(fraction),
    ];

    const risk = Number(
      Math.min(1, evidence.reduce((total, item) => total + item.contribution, 0)).toFixed(3)
    );
    const contributing = evidence.filter((item) => item.contribution > 0).length;

    if (risk < RAISE_AT_RISK) {
      continue;
    }

    // THE CRITERION, APPLIED. A prediction with less than the intervention lead
    // time left is filtered out rather than shown greyed: a list that mixes
    // "act now" with "too late" trains a manager to skim it, and the whole value
    // of the module is that everything in the list is still actionable.
    if (minutesRemaining < minLead) {
      continue;
    }

    signals.push({
      leadId: row.id,
      leadName: row.name,
      ownerUserId: row.owner_user_id,
      ownerName: row.owner_name,
      elapsedMinutes: Math.max(0, Math.round(elapsed / 60000)),
      targetMinutes: Math.max(1, Math.round(window / 60000)),
      minutesRemaining,
      risk,
      confidence: confidenceBand(risk, contributing),
      evidence,
      interventionWindowOpen: true,
      deterministicState: fraction >= AT_RISK_THRESHOLD ? 'at_risk' : 'on_track',
    });
  }

  // Most urgent first: least time left, then highest risk. Sorting by risk alone
  // would put a very risky lead with an hour left above a slightly less risky
  // one with sixteen minutes, which is the wrong order to work in.
  signals.sort((a, b) => a.minutesRemaining - b.minutesRemaining || b.risk - a.risk);

  return {
    signals,
    interventionLeadMinutes: minLead,
    openClocksExamined: rows.length,
    deterministicAtRiskFraction: AT_RISK_THRESHOLD,
    generatedAt: now.toISOString(),
  };
}

/**
 * The daily huddle brief.
 *
 * PROSE ASSEMBLED FROM THE SAME NUMBERS, not a second analysis. A brief computed
 * independently would eventually disagree with the signal list it summarises,
 * and the manager would have no way to tell which was wrong.
 */
export function huddleBrief(report: RiskSignalReport): {
  headline: string;
  lines: string[];
} {
  const { signals } = report;

  if (signals.length === 0) {
    return {
      headline:
        report.openClocksExamined === 0
          ? 'No clocks running. Nothing is being measured.'
          : `${report.openClocksExamined} clock${report.openClocksExamined === 1 ? '' : 's'} running, none predicted to breach.`,
      lines: [],
    };
  }

  const unowned = signals.filter((signal) => signal.ownerUserId === null).length;
  const soonest = signals[0];
  const lines: string[] = [
    `${signals.length} lead${signals.length === 1 ? '' : 's'} predicted to breach with time still to act.`,
    `Most urgent: ${soonest.leadName ?? soonest.leadId} — ${soonest.minutesRemaining} minutes left, risk ${soonest.risk}.`,
  ];

  if (unowned > 0) {
    lines.push(
      `${unowned} of them have no owner. That is the fastest thing to fix and the elapsed-time flag will not raise it.`
    );
  }

  const ahead = signals.filter((signal) => signal.deterministicState === 'on_track').length;
  if (ahead > 0) {
    lines.push(
      `${ahead} are still reported on_track by the elapsed-time rule — these are the ones this brief exists for.`
    );
  }

  return { headline: `Response risk for the next ${report.interventionLeadMinutes}+ minutes`, lines };
}
