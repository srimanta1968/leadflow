import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The design-system gate.
 *
 * Four things must not reappear in application code: a raw hex colour, a
 * hand-rolled table, a hand-rolled overlay, or an ad-hoc KPI tile. Each of the
 * four has already happened in this codebase and each shipped green, because
 * nothing was checking:
 *
 *   - the palette lived in two hand-typed copies and four tokens had gone
 *     missing from one of them;
 *   - four screens each grew their own <table> with its own empty state;
 *   - two dialogs rendered `className="modal xl"` against a `.modal` rule that
 *     is defined NOWHERE, so both were unstyled divs in the page flow;
 *   - three of the four dialogs had no focus trap, no Escape and no scroll lock.
 *
 * WHY A TEST AND NOT ESLINT, which is what the criterion asks for. `npm run lint`
 * in this package runs `eslint src --ext ts,tsx` and eslint is NOT INSTALLED —
 * the script fails with "'eslint' is not recognized". A rule added to a linter
 * that does not run is the same green-gate-guarding-nothing this file exists to
 * prevent. Put in the test suite it runs on every commit, and it moves across
 * unchanged if eslint is adopted.
 */

const SRC = path.resolve(__dirname, '../../src');
const DESIGN_SYSTEM = path.join(SRC, 'design-system');

function sourceFiles(dir: string, ext = /\.(tsx?|css)$/): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full, ext);
    return ext.test(entry.name) ? [full] : [];
  });
}

const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, '/');

/** Files outside the design system — the ones the rules apply to. */
function applicationFiles(): string[] {
  return sourceFiles(SRC).filter((f) => !f.startsWith(DESIGN_SYSTEM));
}

describe('no raw colour outside the design system', () => {
  it('has no hex literal in application code', () => {
    // Nine of these existed as SVG strokes and fills, which Tailwind classes
    // cannot reach — they are now `var(--blue)` and friends, resolved from the
    // same generated custom properties the theme is built from. That is the
    // escape hatch, so there is no reason left to write a hex.
    // TypeScript only. Stylesheets are where the token layer LIVES — the
    // generated :root block is nothing but hex by design, and globals.css
    // consumes it through var(). Scanning CSS caught the generator's own output
    // on the first run, which is the rule being wrong rather than the code.
    const offenders = applicationFiles()
      .filter((f) => /\.tsx?$/.test(f))
      .flatMap((f) => {
        const hits = [...fs.readFileSync(f, 'utf8').matchAll(/#[0-9a-fA-F]{3,8}\b/g)];
        return hits.map((h) => `${rel(f)}: ${h[0]}`);
      });
    expect(
      offenders,
      `raw hex colours — use a token class or cssVar():\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('leaves the design system free to declare them, since that is its job', () => {
    // The gate must not be so broad that the tokens themselves fail it.
    const tokens = fs.readFileSync(path.join(DESIGN_SYSTEM, 'tokens.json'), 'utf8');
    expect(tokens).toMatch(/#[0-9a-f]{6}/i);
  });
});

describe('no bespoke structural markup', () => {
  /**
   * Screens still carrying their own markup, with the reason. An exception that
   * must be TYPED OUT is the point: adding to this list is a visible decision in
   * a diff, where forgetting to migrate a screen is not.
   */
  const GRANDFATHERED_TABLES = new Set([
    // Four tables built from aggregate shapes rather than a row list, so
    // migrating is a rewrite of the screen and not a swap.
    'pages/app/Analytics.tsx',
    // A genuine matrix — roles crossed with capabilities. DataTable models a
    // list of rows; forcing a matrix through it would produce a worse table.
    'features/admin/PermissionMatrix.tsx',
  ]);

  it('routes every table through <DataTable>', () => {
    const offenders = applicationFiles()
      .filter((f) => /<table[\s>]/.test(fs.readFileSync(f, 'utf8')))
      .map(rel)
      .filter((r) => !GRANDFATHERED_TABLES.has(r));
    expect(offenders, `hand-rolled tables:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps the table exception list honest', () => {
    // A stale exception is how a list like this stops meaning anything. This
    // check already caught LeadQueue after it was migrated.
    const stale = [...GRANDFATHERED_TABLES].filter((r) => {
      const full = path.join(SRC, r);
      return !fs.existsSync(full) || !/<table[\s>]/.test(fs.readFileSync(full, 'utf8'));
    });
    expect(stale, `migrated or deleted — remove from the list:\n${stale.join('\n')}`).toEqual([]);
  });

  it('routes every overlay through <Modal> or <Drawer>', () => {
    // `role="dialog"` outside the design system means somebody built their own
    // again — and with it, their own missing focus trap.
    const offenders = applicationFiles()
      .filter((f) => /role=["']dialog["']|aria-modal/.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    expect(
      offenders,
      `hand-rolled dialogs — use <Modal> or <Drawer>, which own focus trap, Escape and scroll lock:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('never references a mockup class the stylesheet does not define', () => {
    /*
     * THE CHECK THAT WOULD HAVE CAUGHT THE UNSTYLED DIALOGS. Two components
     * rendered `className="modal xl"` — the mockup's own class names — while
     * `.modal` was defined nowhere in this codebase, so both were plain divs.
     * Every test passed because none of them assert layout.
     */
    const mockupOnly = ['modal', 'overlay', 'drawer', 'kpis', 'tablewrap', 'wizardpage', 'statusrail'];
    const css = sourceFiles(SRC, /\.css$/).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC, /\.tsx$/)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const cls of mockupOnly) {
        // className="modal ..." or className="... modal" — a bare class, not a
        // Tailwind utility and not part of a longer word.
        const used = new RegExp(`className=["'][^"']*\\b${cls}\\b[^"']*["']`).test(text);
        if (used && !new RegExp(`\\.${cls}\\b`).test(css)) {
          offenders.push(`${rel(file)}: uses .${cls}, which no stylesheet defines`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('the design system offers a home for each rule', () => {
  it('exports the primitive a screen is meant to reach for', () => {
    // A rule with nowhere to go is just an obstacle.
    for (const file of [
      'data/DataTable.tsx', 'data/KpiRail.tsx',
      'overlays/Modal.tsx', 'overlays/Drawer.tsx',
      'tokens.ts', 'tokens.json',
    ]) {
      expect(fs.existsSync(path.join(DESIGN_SYSTEM, file)), `missing ${file}`).toBe(true);
    }
  });
});
