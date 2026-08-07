import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  ALL_NAV_ITEMS,
  NAV_ACTIONS,
  NAV_GROUPS,
  SCREEN_SUBTITLE,
} from '../../src/design-system/shell/navModel';

/**
 * The sidebar's structural invariants.
 *
 * These are the failures that survive review because JSX hides them: an item with
 * no permission gate reads exactly like one with a gate, and a duplicated route
 * looks fine until two entries both highlight. The nav is data precisely so these
 * can be asserted.
 */
describe('the shell navigation model', () => {
  it('either gates an item on an action or states why it is open', () => {
    // An ungated screen is a decision, not an oversight. The type union enforces
    // that one of the two is present; this asserts the stated reason is a real
    // sentence rather than an empty string used to satisfy the type.
    const unexplained = ALL_NAV_ITEMS.filter(
      (i) => !i.action && (!i.ungated || i.ungated.trim().length < 20),
    );
    expect(unexplained.map((i) => i.label)).toEqual([]);
  });

  it('names only actions that EXIST in the server policy vocabulary', () => {
    // THE TEST THAT WOULD HAVE CAUGHT THE REAL BUG. usePermissions fails closed on
    // an unknown action, so an invented name does not error — it silently renders
    // the item as an unclickable span for everyone. This nav first shipped with
    // `lead.read`, `dashboard.view` and `source_record.read`, none of which exist,
    // and the entire sidebar stopped navigating. Read from the server's own config
    // so the list cannot drift from the source of truth.
    const roles = fs.readFileSync(
      path.resolve(__dirname, '../../../server/src/config/roles.ts'),
      'utf8',
    );
    const known = new Set([...roles.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]));
    expect(known.size, 'no capabilities parsed — the config moved or its shape changed')
      .toBeGreaterThan(20);

    const invented = NAV_ACTIONS.filter((a) => !known.has(a));
    expect(invented, `nav actions the PDP has never heard of:\n${invented.join('\n')}`).toEqual([]);
  });

  it('routes each path exactly once', () => {
    const seen = ALL_NAV_ITEMS.map((i) => i.to);
    const duplicated = seen.filter((p, i) => seen.indexOf(p) !== i);
    // Two entries on one path means two highlight together and one is unreachable
    // by name.
    expect([...new Set(duplicated)]).toEqual([]);
  });

  it('keeps every path under /app, so nothing escapes the signed-in shell', () => {
    const stray = ALL_NAV_ITEMS.filter((i) => i.to !== '/app' && !i.to.startsWith('/app/'));
    expect(stray.map((i) => i.to)).toEqual([]);
  });

  it('describes every SHIPPED screen in the top bar', () => {
    // A planned screen has no subtitle because it has no screen. A shipped one
    // without a subtitle silently falls back to the bare product name, which is
    // how a screen ends up unlabelled for a release.
    const missing = ALL_NAV_ITEMS
      .filter((i) => !i.planned)
      .filter((i) => !SCREEN_SUBTITLE[i.to])
      .map((i) => `${i.label} (${i.to})`);
    expect(missing, `shipped screens with no top-bar subtitle:\n${missing.join('\n')}`).toEqual([]);
  });

  it('asks the PDP for each distinct action once', () => {
    // The shell sends NAV_ACTIONS as a single batch; duplicates would mean asking
    // the same question several times per render.
    expect(NAV_ACTIONS.length).toBe(new Set(NAV_ACTIONS).size);
    // The two gates that matter most, named as the policy config names them —
    // not as a reader might guess (`lead.read` is the guess; it does not exist).
    expect(NAV_ACTIONS).toEqual(
      expect.arrayContaining(['lead.work_assigned', 'routing.configure', 'sla.configure']),
    );
  });

  it('names every group and never ships an empty one', () => {
    for (const group of NAV_GROUPS) {
      expect(group.label.trim().length, 'a group with no label renders a bare gap').toBeGreaterThan(0);
      expect(group.items.length, `${group.label} has no items`).toBeGreaterThan(0);
    }
    // The mockup's three groups are reproduced by name; the LeadFlow sections are
    // added in the same grammar rather than a style of their own.
    const labels = NAV_GROUPS.map((g) => g.label.toLowerCase());
    expect(labels).toEqual(
      expect.arrayContaining(['contact operations', 'identity & trust', 'related']),
    );
  });

  it('points every count at a screen that can show the same number', () => {
    // A badge whose screen cannot display the figure it claims is a number with no
    // way to check it.
    const counted = ALL_NAV_ITEMS.filter((i) => i.count);
    expect(counted.length).toBeGreaterThan(0);
    for (const item of counted) {
      expect(item.planned, `${item.label} is planned but carries a live count`).not.toBe(true);
    }
  });
});
