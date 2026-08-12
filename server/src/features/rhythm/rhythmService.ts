import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { BUSINESS_ZONE, instantAtLocal, isHoliday, isWeekend, localParts } from '../sla/businessCalendar';

/**
 * The operating rhythm: scheduled reviews, each with its REQUIRED OUTPUT
 * tracked to completion. SOP §20 and §26.
 *
 * The difference between a reminder and a rhythm is the output. "Send the 11:30
 * sweep" is a notification people learn to skim; "the 11:30 sweep produces
 * reassignments, capacity fixes and coaching moments, and somebody is
 * accountable for each" is the SOP. So every digest here carries the outputs it
 * must produce, and an output still open past its due time escalates.
 */

export interface RhythmDefinition {
  key: string;
  label: string;
  /** Minutes from local midnight, in America/Chicago. */
  minuteOfDay: number;
  /** 'daily', or a weekday number 0-6, or 'monthly'. */
  cadence: 'daily' | 'monthly' | number;
  templateKey: string;
  /** The outputs this review must produce, and how long the owner has. */
  outputs: { key: string; description: string; dueHours: number }[];
}

/**
 * The nine reviews, with their required outputs.
 *
 * THE TIMES ARE LOCAL AND NAMED, never a UTC offset. America/Chicago moves twice
 * a year and a fixed -05:00 puts the launch huddle at 7:45 for half the year —
 * which is the kind of bug that gets blamed on people not showing up.
 */
export const RHYTHMS: RhythmDefinition[] = [
  {
    key: 'overnight_queue', label: 'Overnight queue digest', minuteOfDay: 8 * 60 + 30, cadence: 'daily',
    templateKey: 'digest_overnight_queue',
    outputs: [{ key: 'queue_cleared', description: 'Every overnight lead assigned and contacted or explicitly deferred with a reason', dueHours: 2 }],
  },
  {
    key: 'launch_huddle', label: '8:45 launch huddle pack', minuteOfDay: 8 * 60 + 45, cadence: 'daily',
    templateKey: 'digest_launch_huddle',
    outputs: [
      { key: 'p0_p1_owners', description: 'A named owner for every P0 and P1 item in the pack', dueHours: 1 },
      { key: 'team_focus', description: 'One stated team focus for the day', dueHours: 1 },
    ],
  },
  {
    key: 'sla_sweep', label: '11:30 SLA and stale-task sweep', minuteOfDay: 11 * 60 + 30, cadence: 'daily',
    templateKey: 'digest_sla_sweep',
    outputs: [
      { key: 'reassignments', description: 'Reassignments made for every breached or unworked item', dueHours: 2 },
      { key: 'capacity_fix', description: 'A capacity decision where a rep is over-loaded', dueHours: 2 },
      { key: 'coaching_moment', description: 'A recorded coaching moment where the miss was behavioural', dueHours: 4 },
    ],
  },
  {
    key: 'late_day_sweep', label: '4:30 coverage, payment, no-show and onboarding sweep', minuteOfDay: 16 * 60 + 30, cadence: 'daily',
    templateKey: 'digest_late_day',
    outputs: [
      /* An hour, not a day. The whole point of a 4:30 sweep is that the fix
         happens before people leave — an overnight blocker with no owner is the
         thing this review exists to prevent, and a due date of tomorrow makes
         the review pointless. */
      { key: 'no_unowned_blocker', description: 'No unowned overnight blocker remains', dueHours: 1 },
      { key: 'coverage_confirmed', description: '5:30pm coverage confirmed by name', dueHours: 1 },
    ],
  },
  {
    key: 'next_action_sweep', label: '4:45 stale and overdue NEXT sweep', minuteOfDay: 16 * 60 + 45, cadence: 'daily',
    templateKey: 'digest_next_actions',
    outputs: [{ key: 'no_lead_without_next', description: 'No active lead is left without a dated next action', dueHours: 1 }],
  },
  {
    key: 'weekly_funnel', label: 'Monday funnel, source quality and forecast', minuteOfDay: 9 * 60, cadence: 1,
    templateKey: 'digest_weekly_funnel',
    outputs: [
      { key: 'stage_cleanup', description: 'Stage cleanup completed for misfiled deals', dueHours: 24 },
      { key: 'three_corrective_actions', description: 'Three corrective actions, each with an owner and a date', dueHours: 24 },
    ],
  },
  {
    key: 'weekly_coaching', label: 'Wednesday call coaching', minuteOfDay: 9 * 60, cadence: 3,
    templateKey: 'digest_weekly_coaching',
    outputs: [{ key: 'behaviour_commitment', description: 'One behaviour commitment per rep', dueHours: 24 }],
  },
  {
    key: 'weekly_winloss', label: 'Friday win/loss, opt-out, complaint and reactivation', minuteOfDay: 9 * 60, cadence: 5,
    templateKey: 'digest_weekly_winloss',
    outputs: [{ key: 'reactivation_decisions', description: 'Reactivation decisions recorded for eligible nurture contacts', dueHours: 48 }],
  },
  {
    key: 'monthly_postmortem', label: 'Monthly cross-functional post-mortem', minuteOfDay: 10 * 60, cadence: 'monthly',
    templateKey: 'digest_monthly_postmortem',
    outputs: [
      { key: 'sop_revisions', description: 'Approved SOP and configuration revisions', dueHours: 120 },
      { key: 'retest_plan', description: 'A retest plan for every revision', dueHours: 120 },
    ],
  },
];

export const RHYTHM_KEYS = RHYTHMS.map((r) => r.key);

/** Whether a rhythm is due for the given local day. */
export function dueOn(rhythm: RhythmDefinition, at: Date): boolean {
  const parts = localParts(at);
  if (rhythm.cadence === 'daily') return true;
  if (rhythm.cadence === 'monthly') return parts.day === 1;
  return parts.weekday === rhythm.cadence;
}

/**
 * Generate a digest, once per rhythm per business day.
 *
 * THE UNIQUE CONSTRAINT IS THE GUARANTEE. The generator runs on a timer and two
 * ticks inside the same window would otherwise produce two huddle packs with
 * different numbers — which is worse than one late pack, because now nobody
 * knows which one the meeting is working from.
 */
export async function generate(rhythm: RhythmDefinition, at: Date, content: Record<string, unknown>): Promise<{
  digestId: string | null; created: boolean; businessDate: string;
}> {
  const parts = localParts(at);
  const scheduledAt = instantAtLocal(parts.date, rhythm.minuteOfDay);

  /*
   * period_end IS THE SCHEDULED INSTANT, not the end of the day.
   *
   * 015's unique index is (cadence, audience, period_start, period_end), and
   * five of the nine rhythms are daily and internal — so a whole-day period
   * collided every one of them into a single row. Ending the period at the
   * moment the pack was produced separates them AND is the truer statement: the
   * 11:30 sweep covers the day up to 11:30, and saying it covers up to midnight
   * would claim it saw the afternoon.
   */
  const rows = await dataService.query<{ digest_id: string }>(
    `INSERT INTO leadflow_operating_rhythm_digest
       (tenant_id, rhythm_key, business_date, scheduled_local, template_key, template_version,
        cadence, audience, period_start, period_end, payload)
     VALUES ($1,$2,$3::date,$4,$5,$6,$8,$9,$10::timestamptz,$11::timestamptz,$7::jsonb)
     -- NO CONFLICT TARGET, deliberately. This named
     -- (tenant_id, rhythm_key, business_date), which guards only THAT index —
     -- and 015 carries a second one, leadflow_operating_rhythm_digest_period_idx
     -- over (cadence, audience, period_start, period_end). A tick colliding on
     -- the period index therefore escaped the guard and surfaced as an
     -- unhandled 500 on every subsequent tick, because a targeted ON CONFLICT
     -- suppresses only the constraint it names.
     --
     -- Both indexes express the SAME rule — one digest per rhythm per business
     -- day — so "any unique conflict means it is already generated" is the
     -- truthful reading, and the bare form covers whichever one fires. The
     -- zero-row result is already handled below as created:false.
     ON CONFLICT DO NOTHING
     RETURNING id AS digest_id`,
    [
      config.projexCloud.tenantId, rhythm.key, parts.date,
      `${String(Math.floor(rhythm.minuteOfDay / 60)).padStart(2, '0')}:${String(rhythm.minuteOfDay % 60).padStart(2, '0')} ${BUSINESS_ZONE}`,
      rhythm.templateKey, templateVersionFor(rhythm.templateKey), JSON.stringify(content),
      // 015's columns, which are NOT NULL and stay populated.
      typeof rhythm.cadence === 'number' ? 'weekly' : rhythm.cadence, 'internal',
      instantAtLocal(parts.date, 0).toISOString(), scheduledAt.toISOString(),
    ]
  );
  if (rows.length === 0) return { digestId: null, created: false, businessDate: parts.date };

  const digestId = rows[0].digest_id;
  const due = new Date(scheduledAt.getTime());
  for (const output of rhythm.outputs) {
    await dataService.query(
      `INSERT INTO leadflow_digest_output (tenant_id, digest_id, output_key, description, due_at)
       VALUES ($1,$2,$3,$4,$5::timestamptz) ON CONFLICT (digest_id, output_key) DO NOTHING`,
      [
        config.projexCloud.tenantId, digestId, output.key, output.description,
        new Date(due.getTime() + output.dueHours * 3_600_000).toISOString(),
      ]
    );
  }
  return { digestId, created: true, businessDate: parts.date };
}

/**
 * Template versions, pinned per template.
 *
 * A digest whose template changed silently makes last month's pack unreadable
 * against this month's — the sections move and the archive still claims to be
 * the same document. The version travels on the digest row so an old one renders
 * against the template it was written for.
 */
const TEMPLATE_VERSIONS: Record<string, number> = {
  digest_overnight_queue: 1, digest_launch_huddle: 1, digest_sla_sweep: 1,
  digest_late_day: 1, digest_next_actions: 1, digest_weekly_funnel: 1,
  digest_weekly_coaching: 1, digest_weekly_winloss: 1, digest_monthly_postmortem: 1,
};
export function templateVersionFor(templateKey: string): number {
  return TEMPLATE_VERSIONS[templateKey] ?? 1;
}

/** Deliver a generated digest. Recorded whether or not delivery succeeds. */
export async function deliver(digestId: string, rhythm: RhythmDefinition): Promise<boolean> {
  if (!SdkGatewayClient.isConfigured()) return false;
  try {
    const result = await SdkGatewayClient.call<{ data?: { notification_id?: string } }>({
      sdk: 'sdk-notification', path: '/api/notifications/send', method: 'POST',
      idempotencyKey: `digest:${digestId}`,
      body: {
        tenant_id: config.projexCloud.tenantId, audience: 'internal',
        channel: 'in_app', template_key: rhythm.templateKey, title: rhythm.label,
      },
    });
    if (!result.delivered) return false;
    await dataService.query(
      `UPDATE leadflow_operating_rhythm_digest SET delivered_at = now(), delivery_ref = $2 WHERE id = $1`,
      [digestId, result.data?.data?.notification_id ?? null]
    );
    return true;
  } catch { return false; }
}

/**
 * Escalate outputs that are open past their due time.
 *
 * STAMPED ONCE, by UPDATE ... WHERE escalated_at IS NULL. The sweep runs on a
 * timer and two concurrent passes would both read "not yet escalated" — and a
 * manager who gets the same escalation on every tick stops reading them, which
 * is precisely the failure the escalation exists to prevent.
 */
export async function escalateOverdue(): Promise<{ escalated: number; items: { output_id: string; output_key: string; digest_id: string }[] }> {
  const rows = await dataService.query<{ output_id: string; output_key: string; digest_id: string; description: string }>(
    `UPDATE leadflow_digest_output
        SET escalated_at = now()
      WHERE tenant_id = $1 AND completed_at IS NULL AND escalated_at IS NULL AND due_at < now()
      RETURNING output_id, output_key, digest_id, description`,
    [config.projexCloud.tenantId]
  );
  if (rows.length > 0 && SdkGatewayClient.isConfigured()) {
    for (const row of rows) {
      try {
        await SdkGatewayClient.call({
          sdk: 'sdk-notification', path: '/api/notifications/send', method: 'POST',
          idempotencyKey: `digest-output-overdue:${row.output_id}`,
          body: {
            tenant_id: config.projexCloud.tenantId, audience: 'sales_manager', channel: 'in_app',
            template_key: 'digest_output_overdue', title: `Review output still open: ${row.output_key}`,
            body: row.description,
          },
        });
      } catch { /* the escalated_at stamp is the durable part */ }
    }
  }
  return { escalated: rows.length, items: rows.map((r) => ({ output_id: r.output_id, output_key: r.output_key, digest_id: r.digest_id })) };
}

/**
 * Run every rhythm that is due now.
 *
 * FIRES ON THE BUSINESS CALENDAR. A weekend tick produces nothing: an 8:45
 * huddle pack on a Sunday is noise, and noise is what teaches people to ignore
 * the 8:45 pack on Monday.
 */
export async function tick(now: Date): Promise<{ generated: string[]; skipped: string; escalated: number }> {
  const parts = localParts(now);

  /* Weekends and holidays generate nothing, but escalation STILL RUNS. An
     output that came due on Friday afternoon and is still open on Monday
     morning was overdue the whole weekend, and suppressing the escalation
     because the calendar is closed loses the one signal that it slipped. */
  if (isWeekend(now) || isHoliday(now)) {
    const weekend = await escalateOverdue();
    return { generated: [], skipped: 'not a business day in America/Chicago', escalated: weekend.escalated };
  }

  const generated: string[] = [];
  for (const rhythm of RHYTHMS) {
    if (!dueOn(rhythm, now)) continue;
    if (parts.minuteOfDay < rhythm.minuteOfDay) continue;
    const content = { generated_for: parts.date, rhythm: rhythm.key, outputs: rhythm.outputs.map((o) => o.key) };
    const result = await generate(rhythm, now, content);
    if (result.created && result.digestId) {
      await deliver(result.digestId, rhythm);
      generated.push(rhythm.key);
    }
  }
  const escalation = await escalateOverdue();
  return { generated, skipped: '', escalated: escalation.escalated };
}
