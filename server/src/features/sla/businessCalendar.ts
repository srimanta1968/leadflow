/**
 * The America/Chicago business calendar. SOP §04.
 *
 * A NAMED IANA ZONE, NEVER A FIXED OFFSET. "UTC-6" is correct for Chicago for
 * about four months of the year and an hour wrong for the rest, so a fixed
 * offset produces deadlines that are silently 60 minutes out either side of
 * every DST transition — in March it makes a met SLA look breached, and in
 * November it hides a real breach. The zone name is the only thing that carries
 * the transition rules, so every wall-clock calculation below goes through
 * Intl.DateTimeFormat with `timeZone: BUSINESS_ZONE` rather than through any
 * arithmetic on UTC offsets.
 */

export const BUSINESS_ZONE = 'America/Chicago';

/** Business hours, in local wall-clock minutes from midnight. */
export const OPEN_MINUTE = 9 * 60;        // 09:00
export const CLOSE_MINUTE = 17 * 60;      // 17:00
/** Late coverage runs to 17:30 so a 16:59 arrival has a real 30 minutes. */
export const LATE_COVERAGE_END_MINUTE = 17 * 60 + 30;

/** The response commitment. */
export const SLA_MINUTES = 30;

/** After-hours handling times, next business morning. */
export const DIGEST_MINUTE = 8 * 60 + 30;      // 08:30
export const OWNER_TASK_MINUTE = 8 * 60 + 45;  // 08:45
export const FIRST_CALL_MINUTE = 9 * 60 + 30;  // 09:30

/**
 * The RevOps-maintained holiday list, as local YYYY-MM-DD dates.
 *
 * A LIST RATHER THAN A RULE, because these are not derivable: the observed date
 * of a holiday falling at a weekend is a business decision, not a calculation,
 * and half of them move every year. RevOps maintains it; the code does not
 * guess.
 */
export const HOLIDAYS: readonly string[] = [
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-11-27', '2026-12-24',
  '2026-12-25', '2027-01-01',
];

/** The wall-clock parts of an instant, in the business zone. */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
  /** YYYY-MM-DD in the business zone. */
  date: string;
  /** Minutes from local midnight. */
  minuteOfDay: number;
}

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, weekday: 'short',
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Break an instant into business-zone wall-clock parts.
 *
 * Uses formatToParts rather than any offset arithmetic, so DST is handled by the
 * platform's own tz database instead of by assumptions in this file.
 */
export function localParts(at: Date): LocalParts {
  const parts = Object.fromEntries(
    PARTS.formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  ) as Record<string, string>;

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // Intl renders midnight as hour 24 in some engines; normalise it to 0.
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);

  return {
    year, month, day, hour, minute,
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: hour * 60 + minute,
  };
}

export function isHoliday(at: Date): boolean {
  return HOLIDAYS.includes(localParts(at).date);
}

export function isWeekend(at: Date): boolean {
  const weekday = localParts(at).weekday;
  return weekday === 0 || weekday === 6;
}

/** Why an arrival cannot be worked now, or null when it can. */
export type DeferReason = 'after_hours' | 'weekend' | 'holiday' | null;

/**
 * Whether an arrival falls inside the workable window.
 *
 * THE WINDOW ENDS AT 17:00 FOR ARRIVAL PURPOSES, not at 17:30. Late coverage
 * exists to finish the 30 minutes owed to somebody who arrived at 16:59; it is
 * not an extra half hour of intake. A 17:15 arrival is an after-hours arrival
 * and gets the next-business-day commitment, which is the honest answer.
 */
export function deferReason(at: Date): DeferReason {
  if (isHoliday(at)) return 'holiday';
  if (isWeekend(at)) return 'weekend';
  const { minuteOfDay } = localParts(at);
  if (minuteOfDay < OPEN_MINUTE || minuteOfDay >= CLOSE_MINUTE) return 'after_hours';
  return null;
}

export function isBusinessTime(at: Date): boolean {
  return deferReason(at) === null;
}

/**
 * Build an instant from business-zone wall-clock parts.
 *
 * WHY THIS IS AWKWARD AND HAS TO BE. There is no standard API for "09:00 in
 * America/Chicago on this date"; constructing a UTC instant and shifting it by a
 * guessed offset is exactly the fixed-offset bug this module exists to avoid. So
 * we guess once, measure the actual offset the zone applied at that instant, and
 * correct — then measure again, because a guess that lands inside the one-hour
 * DST gap needs a second pass to settle.
 */
export function instantAtLocal(date: string, minuteOfDay: number): Date {
  const [y, m, d] = date.split('-').map(Number);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;

  let guess = new Date(Date.UTC(y, m - 1, d, hour, minute, 0));
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = localParts(guess);
    const wantedMinutes = hour * 60 + minute;
    const seenMinutes = seen.minuteOfDay;
    // Day difference in whole days, so a correction across midnight settles.
    const dayDelta =
      Date.UTC(y, m - 1, d) - Date.UTC(seen.year, seen.month - 1, seen.day);
    const driftMs = (wantedMinutes - seenMinutes) * 60_000 + dayDelta;
    if (driftMs === 0) break;
    guess = new Date(guess.getTime() + driftMs);
  }
  return guess;
}

/** The next calendar day, as a business-zone date string. */
function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/**
 * The next business day's date, skipping weekends and the holiday list.
 *
 * Bounded at 14 iterations: a holiday list that somehow covered a fortnight
 * would otherwise spin forever, and returning a wrong-but-bounded answer that a
 * human notices beats a hung request nobody can diagnose.
 */
export function nextBusinessDate(from: Date): string {
  let date = nextDate(localParts(from).date);
  for (let i = 0; i < 14; i += 1) {
    const probe = instantAtLocal(date, OPEN_MINUTE);
    if (!isWeekend(probe) && !isHoliday(probe)) return date;
    date = nextDate(date);
  }
  return date;
}

/** What the after-hours path commits to for an arrival outside the window. */
export interface OvernightPlan {
  reason: Exclude<DeferReason, null>;
  nextBusinessDate: string;
  nextBusinessOpen: Date;
  digestAt: Date;
  ownerTaskDueAt: Date;
  firstCallDueAt: Date;
}

export function overnightPlan(at: Date): OvernightPlan | null {
  const reason = deferReason(at);
  if (reason === null) return null;
  const date = nextBusinessDate(at);
  return {
    reason,
    nextBusinessDate: date,
    nextBusinessOpen: instantAtLocal(date, OPEN_MINUTE),
    digestAt: instantAtLocal(date, DIGEST_MINUTE),
    ownerTaskDueAt: instantAtLocal(date, OWNER_TASK_MINUTE),
    firstCallDueAt: instantAtLocal(date, FIRST_CALL_MINUTE),
  };
}

/** How a deadline was arrived at, so a screen never has to reconstruct it. */
export interface SlaDeadline {
  dueAt: Date;
  /** True when the deadline runs past 17:00 and needs the late-coverage roster. */
  requiresLateCoverage: boolean;
  /** Set when the arrival was deferred rather than clocked immediately. */
  deferred: DeferReason;
  basis: string;
}

/**
 * The deadline for an arrival.
 *
 * THE 4:59PM RULE, WHICH IS THE WHOLE POINT. A 16:59 Central arrival is a
 * business-hours arrival, so its deadline is 17:29 — past closing — and late
 * coverage must be STAFFED to meet it. The alternative implementations both lie:
 * clamping the deadline to 17:00 gives the customer 1 minute instead of 30, and
 * deferring it to the next morning quietly converts a 30-minute promise into a
 * 16-hour one. Either way the CRM would be hiding an impossible SLA behind a
 * green number, which SOP §04 names as the failure to avoid.
 */
export function deadlineFor(arrival: Date): SlaDeadline {
  const deferral = deferReason(arrival);

  if (deferral !== null) {
    const plan = overnightPlan(arrival)!;
    return {
      dueAt: plan.firstCallDueAt,
      requiresLateCoverage: false,
      deferred: deferral,
      basis: `Arrived ${deferral.replace('_', ' ')}; acknowledged immediately and committed to a first call by 09:30 ${BUSINESS_ZONE} on ${plan.nextBusinessDate}.`,
    };
  }

  const dueAt = new Date(arrival.getTime() + SLA_MINUTES * 60_000);
  const dueParts = localParts(dueAt);
  const requiresLateCoverage = dueParts.minuteOfDay > CLOSE_MINUTE;

  return {
    dueAt,
    requiresLateCoverage,
    deferred: null,
    basis: requiresLateCoverage
      ? `Business-hours arrival close to closing: the ${SLA_MINUTES}-minute clock runs to ${String(Math.floor(dueParts.minuteOfDay / 60)).padStart(2, '0')}:${String(dueParts.minuteOfDay % 60).padStart(2, '0')} ${BUSINESS_ZONE}, which requires staffed late coverage through 17:30.`
      : `Business-hours arrival: ${SLA_MINUTES} minutes from the original source timestamp.`,
  };
}
