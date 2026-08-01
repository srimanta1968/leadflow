import { describe, expect, it } from 'vitest';
import { NOT_MEASURED, asDuration, asPercent } from '../../src/utils/analyticsFormat';

/**
 * Each case here is a question a usability session puts to a participant —
 * "what does this number tell you?" — turned into an assertion, so the answer
 * cannot drift without a test failing. The protocol those questions come from
 * is docs/analytics-dashboard-user-test-plan.md.
 *
 * The one that matters most is the first group: an empty window must NOT read
 * as a score of zero. The server preserves that distinction all the way to the
 * response, and it would be lost here, in the last three lines before the
 * screen.
 */

describe('asPercent', () => {
  it('renders "nothing to measure" as an em dash, never as 0%', () => {
    // The finding this encodes: 0% next to "response rate" is read as "we
    // answered nobody", which is a different fact from "nobody wrote in".
    expect(asPercent(null)).toBe(NOT_MEASURED);
    expect(asPercent(null)).not.toContain('0');
  });

  it('still renders a genuine zero as 0%', () => {
    // A measured zero is a real and alarming number, and must survive.
    expect(asPercent(0)).toBe('0.0%');
  });

  it('reports a rate to one decimal, so a small weekly move is visible', () => {
    expect(asPercent(0.043)).toBe('4.3%');
    expect(asPercent(0.04)).toBe('4.0%');
  });

  it('renders a complete rate as 100%', () => {
    expect(asPercent(1)).toBe('100.0%');
  });

  it('rounds the fourth decimal the server sends to something readable', () => {
    // The endpoint rounds rates to four decimals; the screen shows one.
    expect(asPercent(0.6667)).toBe('66.7%');
  });
});

describe('asDuration', () => {
  it('renders an unanswered window as an em dash, never as 0s', () => {
    expect(asDuration(null)).toBe(NOT_MEASURED);
  });

  it('keeps a fast response in seconds', () => {
    expect(asDuration(0)).toBe('0s');
    expect(asDuration(42)).toBe('42s');
  });

  it('switches to minutes at the minute, not after it', () => {
    expect(asDuration(59)).toBe('59s');
    expect(asDuration(60)).toBe('1m 0s');
  });

  it('reads a typical response as minutes and seconds', () => {
    expect(asDuration(838)).toBe('13m 58s');
  });

  it('switches to hours at the hour, and drops the seconds there', () => {
    expect(asDuration(3599)).toBe('59m 59s');
    expect(asDuration(3600)).toBe('1h 0m');
    // Four hours and a bit: the seconds would be false precision.
    expect(asDuration(15_000)).toBe('4h 10m');
  });

  it('stays readable for a response that took most of a day', () => {
    expect(asDuration(86_399)).toBe('23h 59m');
  });
});
