/**
 * How an analytics figure is rendered for a person to read.
 *
 * These two functions carry the whole distinction the endpoint goes to some
 * trouble to preserve: `null` means "nothing to measure here" and a number
 * means "measured". The server deliberately returns null rather than zero for a
 * rate with an empty denominator, and rendering the two the same way would
 * throw that away at the last step — a manager reading `0%` next to "response
 * rate" concludes the team answered nothing, when in fact nothing arrived.
 *
 * Kept out of the component so both readings can be asserted directly. They are
 * the exact claims a usability session puts to a participant ("what does this
 * number tell you?"), so they are the ones worth pinning down in a test rather
 * than re-checking by eye — see docs/analytics-dashboard-user-test-plan.md.
 */

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** What every figure shows when there is nothing to measure. */
export const NOT_MEASURED = '—';

/**
 * Render a 0..1 rate as a percentage, or an em dash when it is null.
 *
 * One decimal place: a breach rate moving from 4% to 4.3% is a real change a
 * weekly review acts on, and rounding it away makes the number look static.
 * More than one decimal reads as false precision on a queue of forty leads.
 *
 * @param rate A proportion between 0 and 1, or null when the denominator was
 *             empty.
 */
export function asPercent(rate: number | null): string {
  return rate === null ? NOT_MEASURED : `${(rate * 100).toFixed(1)}%`;
}

/**
 * Render a duration the way somebody says it aloud.
 *
 * "838 seconds" is accurate and unreadable on a dashboard; "13m 58s" is the same
 * fact in the form a manager compares against a thirty-minute target. The unit
 * grows with the magnitude — seconds alone under a minute, minutes and seconds
 * under an hour, hours and minutes above it — because a response time of four
 * hours does not become more useful when reported to the second.
 *
 * @param seconds A whole number of seconds, or null when nothing in the window
 *                has been responded to.
 */
export function asDuration(seconds: number | null): string {
  if (seconds === null) {
    return NOT_MEASURED;
  }
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes}m ${seconds % SECONDS_PER_MINUTE}s`;
  }

  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return `${hours}h ${minutes % MINUTES_PER_HOUR}m`;
}
