import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Emit everything that has to exist as a FILE from the one token source.
 *
 * Two outputs, both generated and both committed:
 *   src/styles/tokens.generated.css — the `:root` custom properties, for the
 *     mockup's own class names, for canvas/SVG code that reads colours at runtime,
 *     and for anything outside Tailwind's reach.
 *   src/design-system/safelist.json — every Tailwind class the runtime helpers in
 *     tokens.ts can assemble. The content scanner cannot see a class built from a
 *     template string, and the resulting unstyled chip appears ONLY in a production
 *     build, which is the worst possible time to discover it.
 *
 * Generated files are committed rather than built on demand so a clone works with
 * no prebuild step. tests/unit/designTokens.test.ts regenerates in memory and fails
 * if either output has drifted, so committing them cannot let them go stale.
 *
 * Run: npm run build:tokens
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '..');
const tokens = JSON.parse(
  fs.readFileSync(path.join(CLIENT, 'src/design-system/tokens.json'), 'utf8'),
);

const real = (group) => Object.entries(group).filter(([k]) => !k.startsWith('_'));

/** The `:root` block. Fonts are joined into a stack; everything else is a scalar. */
export function renderCss() {
  const lines = [];
  for (const [name, value] of real(tokens.color)) lines.push(`  --${name}: ${value};`);
  lines.push('');
  for (const [name, stack] of real(tokens.font)) {
    const quoted = stack.map((f) => (/[^a-z0-9-]/i.test(f) ? `"${f}"` : f)).join(', ');
    lines.push(`  --${name}: ${quoted};`);
  }
  lines.push('');
  for (const [name, value] of real(tokens.shadow)) lines.push(`  --shadow-${name}: ${value};`);
  lines.push('');
  for (const [name, value] of real(tokens.radius)) lines.push(`  --radius-${name}: ${value};`);

  return `/*
 * GENERATED — do not edit.
 *
 * Source: src/design-system/tokens.json
 * Regenerate: npm run build:tokens
 *
 * Hand-editing this file reintroduces exactly the drift it was written to end: the
 * palette used to live here AND in tailwind.config.js as two hand-typed copies, and
 * four tokens had already gone missing from one of them.
 */
:root {
${lines.join('\n')}
}
`;
}

/**
 * Every class chipClass / accentClass / toneClass / captureSourceFill can produce.
 * Derived from the semantic map rather than typed out, so a new role cannot be
 * added without its classes appearing here.
 */
export function renderSafelist() {
  const out = new Set();
  for (const [, { token }] of real(tokens.semantic)) {
    out.add(`border-${token}/40`); out.add(`bg-${token}/10`); out.add(`text-${token}`);
    out.add(`border-${token}/50`); out.add(`hover:bg-${token}/10`);
  }
  for (const [, token] of real(tokens.captureSourceToken)) out.add(`bg-${token}`);
  return [...out].sort();
}

function luminance(c) {
  const h = c.replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

/**
 * The WCAG audit as a readable artifact. The TEST is what enforces the floors;
 * this table is what someone reads when asking "can I put muted on panel3" without
 * running anything. Generated from the same tokens so it cannot describe a palette
 * that is no longer shipped.
 */
export function renderContrast() {
  const { surfaces, bodyText, largeText } = tokens.contrastPairs;
  const c = Object.fromEntries(real(tokens.color));
  const head = `| foreground | ${surfaces.join(' | ')} |\n|---|${surfaces.map(() => '---').join('|')}|`;
  const row = (fg, floor) => {
    const cells = surfaces.map((s) => {
      const r = ratio(c[fg], c[s]);
      return `${r.toFixed(2)}${r >= floor ? '' : ' FAIL'}`;
    });
    return `| \`${fg}\` | ${cells.join(' | ')} |`;
  };
  return `# WCAG 2.2 AA contrast audit

GENERATED from \`src/design-system/tokens.json\` — regenerate with \`npm run build:tokens\`.
The floors are ENFORCED in \`tests/unit/designTokens.test.ts\`; this file is the readable
copy, and it cannot describe a palette that is no longer shipped.

## Body text — AA floor 4.5:1

Every pair below is used for ordinary copy at ordinary weight.

${head}
${bodyText.map((fg) => row(fg, 4.5)).join('\n')}

## Large or bold only — AA floor 3.0:1

\`soft\` and the accents are chip labels, numerals and headings in the mockup, never
body copy. Holding them to 4.5:1 would ban the approved palette outright; holding
them to nothing would let an unreadable accent ship. 3:1 is the AA floor for large
text, which is how they are actually used.

${head}
${largeText.map((fg) => row(fg, 3)).join('\n')}

## What this does not cover

Contrast of a token against a TINTED surface — the \`bg-<token>/10\` chip fills — is
not audited here, because the effective background depends on what is behind the
chip. The chips carry full-strength text on a 10% fill over one of the surfaces
above, so the audited figures are the floor rather than the exact rendered value.
`;
}

const outputs = [
  ['src/styles/tokens.generated.css', renderCss()],
  ['src/design-system/safelist.json', `${JSON.stringify(renderSafelist(), null, 2)}\n`],
  ['src/design-system/CONTRAST.md', renderContrast()],
];

if (process.argv[1] && process.argv[1].endsWith('build-tokens.mjs')) {
  for (const [rel, content] of outputs) {
    const file = path.join(CLIENT, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    console.log(`wrote ${rel}`);
  }
}
