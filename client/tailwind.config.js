import { createRequire } from 'module';

/**
 * LeadFlow design tokens.
 *
 * THE VALUES ARE NOT DECLARED HERE. They come from
 * src/design-system/tokens.json, which is the single source the whole design
 * system reads: this config for the utility classes, scripts/build-tokens.mjs for
 * the `:root` custom properties, and src/design-system/tokens.ts for the typed
 * semantic maps components import.
 *
 * That indirection is the point. This file and src/styles/globals.css previously
 * each carried their own hand-typed copy of the palette, and they had already
 * drifted — `--white`, `--cond`, `--sans` and `--mono` existed here and in the
 * mockup but had gone missing from the CSS mirror. Two lists that must agree will
 * eventually not.
 *
 * Raw hex is not permitted in application code. Use the token names, and pick them
 * through the semantic maps in design-system/tokens.ts rather than by eye.
 */
const require = createRequire(import.meta.url);
const tokens = require('./src/design-system/tokens.json');

/** Drop the `_`-prefixed annotation keys that document each group in the JSON. */
const values = (group) =>
  Object.fromEntries(Object.entries(group).filter(([k]) => !k.startsWith('_')));

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: values(tokens.color),
      fontFamily: values(tokens.font),
      borderRadius: values(tokens.radius),
      spacing: values(tokens.space),
      fontSize: values(tokens.text),
      maxWidth: values(tokens.maxWidth),
      boxShadow: values(tokens.shadow),
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-ring': {
          '0%': { opacity: '0.55', transform: 'scale(0.92)' },
          '70%': { opacity: '0', transform: 'scale(1.35)' },
          '100%': { opacity: '0', transform: 'scale(1.35)' },
        },
      },
      animation: {
        'fade-up': 'fade-up .5s ease-out both',
        'pulse-ring': 'pulse-ring 2.4s ease-out infinite',
      },
    },
  },
  // Classes composed at runtime by design-system/tokens.ts helpers. The content
  // scanner cannot see an assembled string, and the failure only shows up in a
  // production build, so the list is exported from the module that builds them.
  safelist: require('./src/design-system/safelist.json'),
  plugins: [],
};
