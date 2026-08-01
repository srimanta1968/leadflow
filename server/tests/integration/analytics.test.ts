import { AnalyticsService } from '../../src/services/AnalyticsService';
import { validateAnalyticsOverviewQuery } from '../../src/validators/analyticsValidators';
import { AppError } from '../../src/utils/errors';
import { Fixtures } from '../fixtures';

/**
 * Integration tests for the analytics rollup.
 *
 * Run against a REAL database, because everything under test is SQL: the
 * FILTER-ed aggregates, the PERCENTILE_CONT that produces the median and p90,
 * and the half-open window bound. A mocked data layer would assert none of it —
 * it would only re-state the query back to itself.
 *
 * Every fixture is placed in a HISTORICAL window (January 2020). The endpoint
 * aggregates over every lead in range, so tests using "now" could only assert
 * deltas against whatever else the database holds. A window no real capture
 * occupies makes the counts exactly the fixtures', so the assertions are
 * absolute and readable.
 */

/** Half-open reporting window the fixtures live in. */
const WINDOW_FROM = new Date('2020-01-01T00:00:00.000Z');
const WINDOW_TO = new Date('2020-01-08T00:00:00.000Z');

const DAY_ONE = new Date('2020-01-02T09:00:00.000Z');
const DAY_TWO = new Date('2020-01-03T09:00:00.000Z');

describe('AnalyticsService.overview', () => {
  let owner: Awaited<ReturnType<typeof Fixtures.createUser>>;

  beforeEach(async () => {
    await Fixtures.deleteLeadsInWindow(WINDOW_FROM, WINDOW_TO);
    owner = await Fixtures.createUser('Analytics');
  });

  afterEach(async () => {
    await Fixtures.deleteLeadsInWindow(WINDOW_FROM, WINDOW_TO);
  });

  it('counts each funnel stage from the lead projection', async () => {
    // Captured but never routed.
    await Fixtures.createHistoricalLead('web_form', DAY_ONE);
    // Routed, never answered, and breached.
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });
    // Routed and answered inside the window.
    await Fixtures.createHistoricalLead('phone', DAY_TWO, {
      ownerId: owner.id,
      respondedAfterSeconds: 120,
    });

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    expect(overview.funnel).toEqual({
      captured: 3,
      routed: 2,
      responded: 1,
      breached: 1,
    });
  });

  it('reports conversion rates between stages, not against the total', async () => {
    await Fixtures.createHistoricalLead('web_form', DAY_ONE);
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, { ownerId: owner.id });
    await Fixtures.createHistoricalLead('phone', DAY_ONE, {
      ownerId: owner.id,
      respondedAfterSeconds: 60,
    });

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    // 2 of 3 captured reached an owner.
    expect(overview.conversion.routed_rate).toBeCloseTo(2 / 3, 4);
    // 1 of the 2 ROUTED was answered — the denominator is the previous stage,
    // not the total, or the number would silently punish unrouted leads twice.
    expect(overview.conversion.response_rate).toBeCloseTo(1 / 2, 4);
  });

  it('measures the breach rate over closed clocks only', async () => {
    // Closed: answered.
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      respondedAfterSeconds: 30,
    });
    // Closed: breached.
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });
    // OPEN — still inside its window, no verdict yet.
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, { ownerId: owner.id });

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    // One breach out of TWO decided clocks, not out of all three leads. Counting
    // the open clock as a pass would flatter the number.
    expect(overview.conversion.breach_rate).toBeCloseTo(0.5, 4);
  });

  it('returns null rather than zero for a rate with no denominator', async () => {
    // Captured, none routed: there is no routed population to answer.
    await Fixtures.createHistoricalLead('web_form', DAY_ONE);

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    expect(overview.conversion.routed_rate).toBe(0);
    // Null, NOT 0: "nobody answered the leads we routed" and "we routed nothing"
    // are different claims, and a dashboard renders 0% as a failure.
    expect(overview.conversion.response_rate).toBeNull();
    expect(overview.conversion.breach_rate).toBeNull();
    expect(overview.response_times.average_seconds).toBeNull();
  });

  it('measures response time from arrival, and reports the tail as well as the mean', async () => {
    // Nine fast responses and one very slow one. The mean stays respectable;
    // only the p90 exposes the straggler.
    for (let i = 0; i < 9; i += 1) {
      await Fixtures.createHistoricalLead('live_chat', DAY_ONE, {
        ownerId: owner.id,
        respondedAfterSeconds: 60,
      });
    }
    await Fixtures.createHistoricalLead('live_chat', DAY_ONE, {
      ownerId: owner.id,
      respondedAfterSeconds: 3600,
    });

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    expect(overview.response_times.median_seconds).toBe(60);
    // (9 * 60 + 3600) / 10 = 414
    expect(overview.response_times.average_seconds).toBe(414);
    expect(overview.response_times.p90_seconds).toBeGreaterThan(
      overview.response_times.median_seconds as number
    );
  });

  it('narrows to one capture channel when a source filter is given', async () => {
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, { ownerId: owner.id });
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, { ownerId: owner.id });
    await Fixtures.createHistoricalLead('phone', DAY_ONE, { ownerId: owner.id });

    const overview = await AnalyticsService.overview({
      from: WINDOW_FROM,
      to: WINDOW_TO,
      source: 'web_form',
    });

    expect(overview.funnel.captured).toBe(2);
    expect(overview.filters.source).toBe('web_form');
    expect(overview.by_source).toHaveLength(1);
  });

  it('narrows to one representative when an owner filter is given', async () => {
    const other = await Fixtures.createUser('Other');
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, { ownerId: owner.id });
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, { ownerId: other.id });

    const overview = await AnalyticsService.overview({
      from: WINDOW_FROM,
      to: WINDOW_TO,
      owner_user_id: owner.id,
    });

    expect(overview.funnel.captured).toBe(1);
    expect(overview.filters.owner_user_id).toBe(owner.id);
  });

  it('breaks the window into days, ordered oldest first', async () => {
    await Fixtures.createHistoricalLead('web_form', DAY_ONE);
    await Fixtures.createHistoricalLead('web_form', DAY_TWO);
    await Fixtures.createHistoricalLead('phone', DAY_TWO);

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    expect(overview.daily).toEqual([
      { day: '2020-01-02', captured: 1, responded: 0, breached: 0 },
      { day: '2020-01-03', captured: 2, responded: 0, breached: 0 },
    ]);
  });

  it('treats the window as half-open so a boundary lead is counted once', async () => {
    // Exactly on the lower bound — included.
    await Fixtures.createHistoricalLead('web_form', WINDOW_FROM);
    // Exactly on the upper bound — excluded, because it belongs to the NEXT
    // window. Without this a lead on a boundary is reported in both.
    await Fixtures.createHistoricalLead('web_form', WINDOW_TO);

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    expect(overview.funnel.captured).toBe(1);

    // Clean up the one placed outside the window the afterEach hook sweeps.
    await Fixtures.deleteLeadsInWindow(WINDOW_TO, new Date(WINDOW_TO.getTime() + 1000));
  });
});

describe('validateAnalyticsOverviewQuery', () => {
  it('defaults to the last 30 days when neither bound is given', () => {
    const query = validateAnalyticsOverviewQuery({});

    const days = (query.to.getTime() - query.from.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  it('rejects a window whose end is not after its start', () => {
    expect(() =>
      validateAnalyticsOverviewQuery({ from: '2026-07-30', to: '2026-07-01' })
    ).toThrow(AppError);

    // A zero-width window can only ever report nothing, so it is a mistake
    // rather than a request — rejected rather than answered with an empty set.
    expect(() =>
      validateAnalyticsOverviewQuery({ from: '2026-07-30', to: '2026-07-30' })
    ).toThrow(AppError);
  });

  it('rejects a window longer than a year', () => {
    expect(() =>
      validateAnalyticsOverviewQuery({ from: '2020-01-01', to: '2026-01-01' })
    ).toThrow(AppError);
  });

  it('rejects an unparseable bound rather than silently widening the window', () => {
    // `new Date('nonsense')` yields Invalid Date instead of throwing, so an
    // unchecked value would reach SQL as a null bound and report EVERYTHING —
    // a wrong answer that looks like a right one.
    expect(() => validateAnalyticsOverviewQuery({ from: 'nonsense' })).toThrow(AppError);
  });

  it('rejects a source outside the capture-channel vocabulary', () => {
    expect(() => validateAnalyticsOverviewQuery({ source: 'carrier_pigeon' })).toThrow(AppError);
  });

  it('accepts a date-only bound as well as a full instant', () => {
    const dateOnly = validateAnalyticsOverviewQuery({ from: '2026-01-01', to: '2026-02-01' });
    expect(dateOnly.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');

    const instant = validateAnalyticsOverviewQuery({
      from: '2026-01-01T09:30:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });
    expect(instant.from.toISOString()).toBe('2026-01-01T09:30:00.000Z');
  });

  it('treats an empty filter as absent rather than as a value', () => {
    const query = validateAnalyticsOverviewQuery({ source: '', owner_user_id: '' });
    expect(query.source).toBeUndefined();
    expect(query.owner_user_id).toBeUndefined();
  });
});
