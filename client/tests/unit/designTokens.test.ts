import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import tokens from '../../src/design-system/tokens.json';
import { renderCss, renderSafelist } from '../../scripts/build-tokens.mjs';

/**
 * The design system's gate.
 *
 * Three things are asserted here that a review cannot check by eye:
 *
 *   1. ZERO COLOUR DRIFT from the approved mockup. The mockup's `:root` is parsed
 *      out of the HTML and compared token by token, so "ported verbatim" is a fact
 *      rather than a claim in a comment. The previous arrangement asserted it in
 *      prose while four tokens were quietly missing.
 *   2. THE GENERATED FILES ARE CURRENT. tokens.generated.css and safelist.json are
 *      committed so a clone needs no prebuild, which means they can go stale. Both
 *      are regenerated in memory and compared, so a token edit that forgets
 *      `npm run build:tokens` fails here instead of shipping a half-updated palette.
 *   3. WCAG 2.2 AA for every text-on-surface pair, computed rather than eyeballed.
 *      Dark themes are where contrast quietly fails: #6e6e79 on #202027 looks fine
 *      to a designer on a good monitor and is unreadable on a laptop in daylight.
 */

const MOCKUP = path.resolve(__dirname, '../../../docs/Prd/lynkeduppro_contact_workflow_studio (1).html');

/** Parse the mockup's own `:root` block — the binding contract. */
function mockupTokens(): Record<string, string> {
  const html = fs.readFileSync(MOCKUP, 'utf8');
  const root = /:root\s*\{([\s\S]*?)\}/.exec(html);
  if (!root) throw new Error('the mockup has no :root block — the contract moved');
  return Object.fromEntries(
    [...root[1].matchAll(/--([a-z0-9]+)\s*:\s*([^;]+)/gi)].map((m) => [m[1], m[2].trim()]),
  );
}

const hex = (v: string): string => {
  const h = v.trim().toLowerCase();
  return h === '#fff' ? '#ffffff' : h;
};

/** Relative luminance, per WCAG 2.x. */
function luminance(color: string): number {
  const h = color.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const color = tokens.color as Record<string, string>;
const pairs = tokens.contrastPairs;

describe('design tokens match the approved mockup', () => {
  it('ports every mockup token with zero colour drift', () => {
    const mock = mockupTokens();
    const drift: string[] = [];
    for (const [name, value] of Object.entries(mock)) {
      // Fonts and the shadow are compared separately below; colours must match exactly.
      if (!/^#/.test(value.trim())) continue;
      const ours = color[name];
      if (!ours) { drift.push(`--${name} exists in the mockup but not in tokens.json`); continue; }
      if (hex(ours) !== hex(value)) drift.push(`--${name}: mockup ${value} vs tokens ${ours}`);
    }
    expect(drift.join('\n'), `colour drift from the mockup:\n${drift.join('\n')}`).toBe('');
  });

  it('ports the font stacks and the panel shadow', () => {
    const mock = mockupTokens();
    // The mockup declares these as tokens too, and they were the ones missing from
    // the old CSS mirror, so they are asserted rather than assumed.
    for (const family of ['sans', 'cond', 'mono'] as const) {
      expect(mock[family], `--${family} missing from the mockup`).toBeTruthy();
      expect(tokens.font[family][0]).toBe(mock[family].split(',')[0].replace(/["']/g, '').trim());
    }
    const norm = (s: string) => s.replace(/\s|0(?=\.)/g, '');
    expect(norm(tokens.shadow.panel)).toBe(norm(mock.shadow));
  });

  it('has not let the generated files go stale', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../', rel), 'utf8');
    // Regenerated in memory from the same source the script uses. A token edit that
    // skipped `npm run build:tokens` shows up here, not in a production build.
    expect(read('src/styles/tokens.generated.css')).toBe(renderCss());
    expect(JSON.parse(read('src/design-system/safelist.json'))).toEqual(renderSafelist());
  });
});

describe('WCAG 2.2 AA contrast, computed for every text-on-surface pair', () => {
  it('clears 4.5:1 for body text on every surface', () => {
    const failures: string[] = [];
    for (const surface of pairs.surfaces) {
      for (const fg of pairs.bodyText) {
        const ratio = contrast(color[fg], color[surface]);
        if (ratio < 4.5) failures.push(`${fg} on ${surface}: ${ratio.toFixed(2)}:1 (AA needs 4.5)`);
      }
    }
    expect(failures.join('\n'), `AA body-text failures:\n${failures.join('\n')}`).toBe('');
  });

  it('clears 3:1 for accents and the faintest tier, which are large or bold only', () => {
    // These are chip labels, numerals and headings in the mockup — never body copy.
    // 3:1 is the AA floor for large text; asserting 4.5 here would ban the palette,
    // and asserting nothing would let an unreadable accent through.
    const failures: string[] = [];
    for (const surface of pairs.surfaces) {
      for (const fg of pairs.largeText) {
        const ratio = contrast(color[fg], color[surface]);
        if (ratio < 3) failures.push(`${fg} on ${surface}: ${ratio.toFixed(2)}:1 (large-text AA needs 3.0)`);
      }
    }
    expect(failures.join('\n'), `AA large-text failures:\n${failures.join('\n')}`).toBe('');
  });

  it('CAN fail — a deliberately poor pair is caught', () => {
    // Without this, a broken luminance function would report every pair as passing.
    expect(contrast('#202027', '#1b1b20')).toBeLessThan(3);
    expect(contrast('#f4f4f6', '#070708')).toBeGreaterThan(4.5);
  });
});
