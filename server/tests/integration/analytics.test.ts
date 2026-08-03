import { AnalyticsService } from '../../src/services/AnalyticsService';
import { config } from '../../src/config/env';
import { SdkGatewayClient } from '../../src/services/projexcloud/SdkGatewayClient';
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

/**
 * The ProjexCloud SDK's contribution to the rollup.
 *
 * `sdk-sla` judges a deadline against the tenant's business calendar; the local
 * fallback compares plain elapsed time. Both are legitimate, and they are not
 * the same measurement — so the window has to say which one its breach figures
 * came from, rather than averaging the two silently.
 */
describe('AnalyticsService.overview clock provenance', () => {
  let owner: Awaited<ReturnType<typeof Fixtures.createUser>>;

  beforeEach(async () => {
    await Fixtures.deleteLeadsInWindow(WINDOW_FROM, WINDOW_TO);
    owner = await Fixtures.createUser('Provenance');
  });

  afterEach(async () => {
    await Fixtures.deleteLeadsInWindow(WINDOW_FROM, WINDOW_TO);
  });

  it('reports which clock judged the closed verdicts', async () => {
    const breached = await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });
    const met = await Fixtures.createHistoricalLead('phone', DAY_TWO, {
      ownerId: owner.id,
      respondedAfterSeconds: 120,
    });
    await Fixtures.recordObservation(breached.id, 'sdk_sla', 'breached');
    await Fixtures.recordObservation(met.id, 'sdk_sla', 'met');

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    expect(overview.clock_provenance.by_clock_source).toEqual([
      { clock_source: 'sdk_sla', closed: 2, breached: 1 },
    ]);
    expect(overview.clock_provenance.mixed).toBe(false);
  });

  it('flags a window whose verdicts came from BOTH clocks', async () => {
    // The case this whole block exists for: a gateway outage in the middle of a
    // reporting period leaves half the window judged on the business calendar
    // and half on the wall clock. The blended breach rate is not wrong, but it
    // is not defensible without the caveat either.
    const onCalendar = await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });
    const onWallClock = await Fixtures.createHistoricalLead('web_form', DAY_TWO, {
      ownerId: owner.id,
      breached: true,
    });
    await Fixtures.recordObservation(onCalendar.id, 'sdk_sla', 'breached');
    await Fixtures.recordObservation(onWallClock.id, 'local_wallclock', 'breached');

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    expect(overview.clock_provenance.mixed).toBe(true);
    expect(
      overview.clock_provenance.by_clock_source.map((share) => share.clock_source).sort()
    ).toEqual(['local_wallclock', 'sdk_sla']);
  });

  it('reports an unobserved closed clock as null rather than as a third clock', async () => {
    const unobserved = await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });
    const observed = await Fixtures.createHistoricalLead('phone', DAY_TWO, {
      ownerId: owner.id,
      breached: true,
    });
    await Fixtures.recordObservation(observed.id, 'sdk_sla', 'breached');
    expect(unobserved.id).toBeTruthy();

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    const shares = overview.clock_provenance.by_clock_source;
    expect(shares).toContainEqual({ clock_source: null, closed: 1, breached: 1 });
    expect(shares).toContainEqual({ clock_source: 'sdk_sla', closed: 1, breached: 1 });
    // A gap in the record is not a second clock: one attributed source only.
    expect(overview.clock_provenance.mixed).toBe(false);
  });

  it('counts the same population as the breach rate denominator', async () => {
    // Closed: answered.
    const answered = await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      respondedAfterSeconds: 60,
    });
    // Closed: breached.
    const breached = await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });
    // OPEN: routed, unanswered, not yet breached. Must appear in neither.
    await Fixtures.createHistoricalLead('phone', DAY_TWO, { ownerId: owner.id });

    await Fixtures.recordObservation(answered.id, 'local_wallclock', 'met');
    await Fixtures.recordObservation(breached.id, 'local_wallclock', 'breached');

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    const closed = overview.clock_provenance.by_clock_source.reduce(
      (total, share) => total + share.closed,
      0
    );
    // breach_rate is breached / closed = 1/2, so provenance must cover 2.
    expect(closed).toBe(2);
    expect(overview.conversion.breach_rate).toBe(0.5);
    expect(overview.funnel.captured).toBe(3);
  });

  it('states the clock a verdict recorded right now would carry', async () => {
    // CONTROLS the gateway config rather than reading whatever the developer's
    // .env happens to hold. The pair is the assertion — the reported clock must
    // FOLLOW from whether the gateway is configured, never be stated
    // independently of it — and that pairing is exactly what an ambient-config
    // assertion cannot check: hardcoding `false` passes for the right reason on
    // one machine and the wrong reason on the next.
    const url = config.projexCloud.gatewayUrl;
    const key = config.projexCloud.apiKey;

    try {
      config.projexCloud.gatewayUrl = '';
      config.projexCloud.apiKey = '';
      const fellBack = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });
      expect(fellBack.clock_provenance.gateway_configured).toBe(false);
      expect(fellBack.clock_provenance.current_clock_source).toBe('local_wallclock');

      config.projexCloud.gatewayUrl = 'http://gateway.test';
      config.projexCloud.apiKey = 'test-credential';
      const upstream = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });
      expect(upstream.clock_provenance.gateway_configured).toBe(true);
      expect(upstream.clock_provenance.current_clock_source).toBe('sdk_sla');
    } finally {
      config.projexCloud.gatewayUrl = url;
      config.projexCloud.apiKey = key;
    }
  });

  it('narrows provenance with the same filters as the rest of the rollup', async () => {
    const web = await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });
    const phone = await Fixtures.createHistoricalLead('phone', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });
    await Fixtures.recordObservation(web.id, 'sdk_sla', 'breached');
    await Fixtures.recordObservation(phone.id, 'local_wallclock', 'breached');

    const overview = await AnalyticsService.overview({
      from: WINDOW_FROM,
      to: WINDOW_TO,
      source: 'web_form',
    });

    // Filtered to web_form, only the business-calendar verdict remains — so the
    // window is no longer mixed even though the unfiltered one is.
    expect(overview.clock_provenance.by_clock_source).toEqual([
      { clock_source: 'sdk_sla', closed: 1, breached: 1 },
    ]);
    expect(overview.clock_provenance.mixed).toBe(false);
  });
});

/**
 * The `sdk-sla` attainment fetch.
 *
 * The gateway is deliberately unconfigured in this environment, so the API
 * runner can only ever exercise the fallback — the delivered path has no
 * executable proof anywhere else and is stubbed at the client boundary here.
 * The stub replaces the HTTP call and nothing above it, so the reconciliation
 * this block is actually about is the real code.
 */
describe('AnalyticsService.overview sdk-sla attainment', () => {
  let owner: Awaited<ReturnType<typeof Fixtures.createUser>>;

  /** Answer the gateway call as `sdk-sla` would, without a gateway. */
  function stubGateway(attainment: unknown): jest.SpyInstance {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    return jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 200, data: { data: { attainment } } });
  }

  beforeEach(async () => {
    await Fixtures.deleteLeadsInWindow(WINDOW_FROM, WINDOW_TO);
    owner = await Fixtures.createUser('Attainment');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Fixtures.deleteLeadsInWindow(WINDOW_FROM, WINDOW_TO);
  });

  it('counts attainment locally when no gateway is configured', async () => {
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      respondedAfterSeconds: 60,
    });
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    expect(overview.attainment).toEqual({
      delivered: false,
      source: 'local_wallclock',
      target_minutes: expect.any(Number),
      closed: 2,
      met: 1,
      breached: 1,
      attainment_rate: 0.5,
    });
  });

  it('reports the upstream verdict, and the window it was asked about', async () => {
    // Locally this window is 1 of 2 met. Upstream judges it on the tenant's
    // business calendar and disagrees — which is the entire reason for asking.
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      respondedAfterSeconds: 60,
    });
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });
    const call = stubGateway({ target_minutes: 45, closed: 2, met: 2, breached: 0 });

    const overview = await AnalyticsService.overview({
      from: WINDOW_FROM,
      to: WINDOW_TO,
      source: 'web_form',
    });

    expect(overview.attainment).toEqual({
      delivered: true,
      source: 'sdk_sla',
      target_minutes: 45,
      closed: 2,
      met: 2,
      breached: 0,
      attainment_rate: 1,
    });
    // ONE call for the window, carrying the screen's own filters — not one per
    // lead, and not an unfiltered question whose answer covers a different
    // population than every other number on the screen.
    expect(call).toHaveBeenCalledTimes(1);

    // GET with query parameters. Verified against the running gateway:
    //   POST /api/sla/attainment                   -> 404
    //   GET  /api/sla/attainment?tenant_id&from&to -> 200
    // The previous assertion pinned POST with a body, which matched the code
    // and matched nothing the gateway serves — the call had never once
    // succeeded, and the test could not have told us.
    const sent = call.mock.calls[0][0] as { sdk: string; method: string; path: string };
    expect(sent.sdk).toBe('sdk-sla');
    expect(sent.method).toBe('GET');

    const [route, queryString] = sent.path.split('?');
    expect(route).toBe('/api/sla/attainment');

    const params = new URLSearchParams(queryString);
    // The screen's own filters, so upstream aggregates exactly the population
    // every other number on the page counts — not one call per lead, and not an
    // unfiltered question about a different population.
    expect(params.get('from')).toBe(WINDOW_FROM.toISOString());
    expect(params.get('to')).toBe(WINDOW_TO.toISOString());
    expect(params.get('source')).toBe('web_form');
    // Required by the endpoint, and app-scoped rather than customer-scoped.
    expect(params.get('tenant_id')).not.toBeNull();
    // The local counts are untouched by the upstream answer: the two are
    // different measurements and the rollup must not blend them.
    expect(overview.funnel.breached).toBe(1);
    expect(overview.conversion.breach_rate).toBe(0.5);
  });

  it('falls back rather than failing when the gateway errors', async () => {
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    jest.spyOn(SdkGatewayClient, 'call').mockRejectedValue(new Error('gateway timeout'));
    // The failure is logged; silencing it keeps the suite output honest about
    // what is deliberate rather than looking like an unhandled error.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    expect(overview.attainment.delivered).toBe(false);
    expect(overview.attainment.source).toBe('local_wallclock');
    expect(overview.attainment.closed).toBe(1);
    expect(overview.attainment.met).toBe(0);
  });

  it('treats an answer with no closed count as no answer', async () => {
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      respondedAfterSeconds: 30,
    });
    // `met` with no denominator cannot become a rate. Reading it as 0 closed
    // would report a perfect window nobody measured.
    stubGateway({ met: 4 });

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    expect(overview.attainment.delivered).toBe(false);
    expect(overview.attainment.closed).toBe(1);
    expect(overview.attainment.attainment_rate).toBe(1);
  });

  it('never lets upstream report more clocks met than it closed', async () => {
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });
    stubGateway({ closed: 2, met: 5, breached: 0 });

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    // Clamped, so the screen shows a defensible 100% rather than 250%.
    expect(overview.attainment.met).toBe(2);
    expect(overview.attainment.attainment_rate).toBe(1);
  });

  it('derives met from breached when upstream omits it', async () => {
    await Fixtures.createHistoricalLead('web_form', DAY_ONE, {
      ownerId: owner.id,
      breached: true,
    });
    stubGateway({ closed: 4, breached: 1 });

    const overview = await AnalyticsService.overview({ from: WINDOW_FROM, to: WINDOW_TO });

    expect(overview.attainment.met).toBe(3);
    expect(overview.attainment.attainment_rate).toBe(0.75);
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
