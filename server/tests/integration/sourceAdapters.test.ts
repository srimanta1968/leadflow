import {
  SOURCE_ADAPTERS,
  adapterFor,
  adapterKeys,
  launchEvidenceFor,
} from '../../src/config/sourceAdapters';
import {
  applyAttribution,
  extractAttribution,
  readAttribution,
} from '../../src/features/intake/attribution';
import { INTAKE_PLATFORMS } from '../../src/features/intake/intakeService';
import { dataService } from '../../src/services/DataService';

/**
 * Source adapters and attribution.
 *
 * The adapter registry is checked as a whole rather than one entry at a time:
 * the failure this guards is a source added WITHOUT a queue owner or a manual
 * fallback, and a per-adapter test only catches that for adapters somebody
 * remembered to write a test for.
 */

const created: string[] = [];

beforeAll(async () => {
  await dataService.query("DELETE FROM leads WHERE name LIKE 'ATTR-TEST%'", []);
});

/** A lead row to hang attribution off. */
async function makeLead(): Promise<string> {
  const row = await dataService.queryOne<{ id: string }>(
    `INSERT INTO leads (name, email, source) VALUES ($1, $2, $3) RETURNING id`,
    [`ATTR-TEST ${Date.now()}`, `attr${Date.now()}@example.test`, 'web_form']
  );
  created.push(row!.id);
  return row!.id;
}

describe('every adapter is completely specified', () => {
  it('covers the channels SOP §29 names', () => {
    const keys = adapterKeys();
    for (const expected of [
      'meta_lead_ads',
      'linkedin',
      'google_lsa',
      'tiktok',
      'web_form',
      'chat_handoff',
      'phone',
      'email',
      'referral',
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it('gives EVERY adapter a required field set', () => {
    for (const adapter of SOURCE_ADAPTERS) {
      expect(adapter.requiredFields.length).toBeGreaterThan(0);
    }
  });

  it('gives EVERY adapter a named failure-queue owner with a basis', () => {
    for (const adapter of SOURCE_ADAPTERS) {
      // A role, never a person: people change and the queue does not.
      expect(adapter.failureQueue.role.length).toBeGreaterThan(0);
      // And a basis, so an invented owner is visible as an ELABORATION rather
      // than passing for SOP text.
      expect(adapter.failureQueue.basis.length).toBeGreaterThan(10);
    }
  });

  it('gives EVERY adapter a manual fallback, and never "wait"', () => {
    for (const adapter of SOURCE_ADAPTERS) {
      expect(adapter.manualFallback.length).toBeGreaterThan(20);
      // A channel whose fallback is waiting loses leads a person could have
      // typed in ninety seconds.
      expect(adapter.manualFallback.toLowerCase()).not.toMatch(/^wait\b/);
    }
  });

  it('declares permission fields explicitly, including when there are none', () => {
    for (const adapter of SOURCE_ADAPTERS) {
      // An array is always present. "This channel needs none" and "nobody has
      // worked out what this channel needs" must not look alike.
      expect(Array.isArray(adapter.permissionFields)).toBe(true);
    }
    // And at least the paid-social channels, where consent is collected in the
    // form itself, must actually name some.
    expect(adapterFor('meta_lead_ads')?.permissionFields.length).toBeGreaterThan(0);
    expect(adapterFor('linkedin')?.permissionFields.length).toBeGreaterThan(0);
  });

  it('treats recording consent as a permission field on inbound phone', () => {
    // The caller consented to be CALLED by calling. They did not consent to
    // being recorded, and conflating the two is how a call recording becomes
    // unusable evidence.
    expect(adapterFor('phone')?.permissionFields).toContain('recording_consent_policy');
  });

  it('names attribution that must survive for every adapter', () => {
    for (const adapter of SOURCE_ADAPTERS) {
      expect(adapter.attributionFields.length).toBeGreaterThan(0);
    }
  });

  it('uses adapter keys the intake endpoint actually accepts', () => {
    // An adapter whose key the intake validator rejects is configuration that
    // can never fire — and it would look complete in every review.
    const platforms = new Set<string>(INTAKE_PLATFORMS);
    const orphans = adapterKeys().filter((key) => !platforms.has(key));
    expect(orphans).toEqual([]);
  });
});

describe('the launch-evidence packet', () => {
  it('is produced for every adapter', () => {
    for (const adapter of SOURCE_ADAPTERS) {
      expect(launchEvidenceFor(adapter.key)).not.toBeNull();
    }
  });

  it('reports every adapter ready to launch', () => {
    for (const adapter of SOURCE_ADAPTERS) {
      const packet = launchEvidenceFor(adapter.key);
      const unmet = packet?.items.filter((item) => !item.satisfied).map((item) => item.check);
      expect(unmet).toEqual([]);
    }
  });

  it('cites a named artefact for each check, not "we tested it"', () => {
    const packet = launchEvidenceFor('meta_lead_ads');
    for (const item of packet?.items ?? []) {
      expect(item.evidence.length).toBeGreaterThan(10);
    }
  });

  it('counts an empty permission list as SATISFIED rather than failed', () => {
    // Failing it would push somebody to invent a permission field to clear the
    // check, which is worse than an honest empty list.
    const packet = launchEvidenceFor('phone');
    const permission = packet?.items.find((i) => i.check.startsWith('Permission'));
    expect(permission?.satisfied).toBe(true);
  });

  it('returns null for an adapter that does not exist', () => {
    expect(launchEvidenceFor('carrier_pigeon')).toBeNull();
  });
});

describe('attribution extraction', () => {
  it('reads a platform-native campaign block', () => {
    const attribution = extractAttribution(
      'meta_lead_ads',
      'evt-1',
      {},
      { campaign_id: 'c-100', ad_id: 'a-200', creative_id: 'cr-300', form_id: 'f-400' }
    );

    expect(attribution.campaignId).toBe('c-100');
    expect(attribution.adId).toBe('a-200');
    expect(attribution.creativeId).toBe('cr-300');
    expect(attribution.formId).toBe('f-400');
  });

  it('accepts each platform’s own spelling', () => {
    // None of them will change to suit us: Meta says campaign_id, Google says
    // campaignId, and the alias list is what stops that becoming a per-platform
    // branch in the handler.
    expect(extractAttribution('google_lsa', null, { campaignId: 'g-1' }, null).campaignId).toBe(
      'g-1'
    );
    expect(extractAttribution('meta_lead_ads', null, { campaign_id: 'm-1' }, null).campaignId).toBe(
      'm-1'
    );
  });

  it('normalises every network’s click id into ONE field', () => {
    // gclid, fbclid, ttclid and li_fat_id are the same concept. A column per
    // network means a migration every time marketing adds a channel, and which
    // network it came from is already `platform`.
    expect(extractAttribution('google_lsa', null, { gclid: 'g' }, null).clickId).toBe('g');
    expect(extractAttribution('meta_lead_ads', null, { fbclid: 'f' }, null).clickId).toBe('f');
    expect(extractAttribution('tiktok', null, { ttclid: 't' }, null).clickId).toBe('t');
    expect(extractAttribution('linkedin', null, { li_fat_id: 'l' }, null).clickId).toBe('l');
  });

  it('reads UTM from a nested block or from the top level', () => {
    expect(
      extractAttribution('web_form', null, { utm: { utm_source: 'newsletter' } }, null).utmSource
    ).toBe('newsletter');
    expect(extractAttribution('web_form', null, { utm_source: 'flat' }, null).utmSource).toBe(
      'flat'
    );
  });

  it('returns nulls rather than empty strings when there is no campaign', () => {
    const attribution = extractAttribution('phone', null, {}, null);

    // "No campaign" and "campaign unknown" must stay distinguishable — '' would
    // collapse them in exactly the report this exists to serve.
    expect(attribution.campaignId).toBeNull();
    expect(attribution.utmSource).toBeNull();
  });

  it('ignores whitespace-only values', () => {
    expect(extractAttribution('web_form', null, { campaign_id: '   ' }, null).campaignId).toBeNull();
  });
});

describe('attribution survives to closed-won', () => {
  it('persists onto the lead and reads back intact', async () => {
    const leadId = await makeLead();
    const attribution = extractAttribution(
      'meta_lead_ads',
      'evt-survive-1',
      { fbclid: 'fb-123', utm: { utm_source: 'meta', utm_medium: 'paid_social' } },
      { campaign_id: 'c-1', ad_id: 'a-1' }
    );

    expect(await applyAttribution(leadId, attribution)).toBe(1);

    const read = await readAttribution(leadId);
    expect(read?.campaignId).toBe('c-1');
    expect(read?.clickId).toBe('fb-123');
    expect(read?.utmSource).toBe('meta');
    expect(read?.sourceEventId).toBe('evt-survive-1');
  });

  it('SURVIVES routing, response and close — the whole point of the criterion', async () => {
    const leadId = await makeLead();
    await applyAttribution(
      leadId,
      extractAttribution('google_lsa', 'evt-survive-2', { gclid: 'g-9' }, { campaign_id: 'c-9' })
    );

    // The lead's life: routed, answered, closed. Each of these updates the row.
    await dataService.query(
      `UPDATE leads SET owner_user_id = NULL, routing_method = 'round_robin',
              assigned_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [leadId]
    );
    await dataService.query(
      `UPDATE leads SET first_response_at = CURRENT_TIMESTAMP, sla_breached = false WHERE id = $1`,
      [leadId]
    );
    await dataService.query(`UPDATE leads SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [
      leadId,
    ]);

    const read = await readAttribution(leadId);
    expect(read?.campaignId).toBe('c-9');
    expect(read?.clickId).toBe('g-9');
  });

  it('a later EMPTY signal cannot blank an earlier campaign', async () => {
    const leadId = await makeLead();
    await applyAttribution(
      leadId,
      extractAttribution('meta_lead_ads', 'evt-1', {}, { campaign_id: 'c-keep' })
    );

    // A routing update or a second touch carrying no attribution must not erase
    // the campaign that produced the lead — the most likely way attribution is
    // lost in practice, and COALESCE on write is what prevents it.
    await applyAttribution(leadId, extractAttribution('web_form', null, {}, null));

    expect((await readAttribution(leadId))?.campaignId).toBe('c-keep');
  });

  it('reports zero rows for a lead that does not exist', async () => {
    const updated = await applyAttribution(
      '00000000-0000-0000-0000-000000000000',
      extractAttribution('web_form', null, {}, null)
    );
    // A silent no-op against a wrong id would look identical to a successful
    // write, and the campaign would quietly go missing.
    expect(updated).toBe(0);
  });
});
