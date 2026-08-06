# WCAG 2.2 AA contrast audit

GENERATED from `src/design-system/tokens.json` — regenerate with `npm run build:tokens`.
The floors are ENFORCED in `tests/unit/designTokens.test.ts`; this file is the readable
copy, and it cannot describe a palette that is no longer shipped.

## Body text — AA floor 4.5:1

Every pair below is used for ordinary copy at ordinary weight.

| foreground | bg | bg2 | sidebar | panel | panel2 | panel3 |
|---|---|---|---|---|---|---|
| `text` | 18.33 | 18.00 | 17.90 | 16.58 | 15.62 | 14.74 |
| `muted` | 7.14 | 7.01 | 6.97 | 6.46 | 6.08 | 5.74 |

## Large or bold only — AA floor 3.0:1

`soft` and the accents are chip labels, numerals and headings in the mockup, never
body copy. Holding them to 4.5:1 would ban the approved palette outright; holding
them to nothing would let an unreadable accent ship. 3:1 is the AA floor for large
text, which is how they are actually used.

| foreground | bg | bg2 | sidebar | panel | panel2 | panel3 |
|---|---|---|---|---|---|---|
| `soft` | 4.00 | 3.93 | 3.90 | 3.62 | 3.41 | 3.21 |
| `blue` | 5.60 | 5.49 | 5.46 | 5.06 | 4.77 | 4.50 |
| `green` | 10.53 | 10.34 | 10.29 | 9.53 | 8.97 | 8.47 |
| `gold` | 10.84 | 10.65 | 10.59 | 9.80 | 9.24 | 8.72 |
| `purple` | 5.28 | 5.19 | 5.16 | 4.78 | 4.50 | 4.25 |
| `cyan` | 9.81 | 9.64 | 9.58 | 8.88 | 8.36 | 7.89 |
| `red` | 6.28 | 6.17 | 6.13 | 5.68 | 5.35 | 5.05 |
| `orange` | 7.68 | 7.54 | 7.50 | 6.94 | 6.54 | 6.17 |
| `mag` | 6.22 | 6.11 | 6.07 | 5.62 | 5.30 | 5.00 |

## What this does not cover

Contrast of a token against a TINTED surface — the `bg-<token>/10` chip fills — is
not audited here, because the effective background depends on what is behind the
chip. The chips carry full-strength text on a 10% fill over one of the surfaces
above, so the audited figures are the floor rather than the exact rendered value.
