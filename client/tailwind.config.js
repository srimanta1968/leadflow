/**
 * LeadFlow design tokens.
 *
 * Every value below is ported verbatim from the `:root` block of the approved
 * mockup (`docs/Prd/lynkeduppro_contact_workflow_studio (1).html`), which is the
 * binding UI contract rather than a reference. Raw hex colours are not permitted
 * anywhere in application code — use these token names so a change to the
 * mockup propagates in one place.
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces, darkest to lightest.
        bg: '#070708',
        bg2: '#0a0a0d',
        sidebar: '#0b0b0d',
        panel: '#151519',
        panel2: '#1b1b20',
        panel3: '#202027',

        // Borders.
        line: '#303038',
        line2: '#3a3a44',

        // Type.
        text: '#f4f4f6',
        muted: '#9999a4',
        soft: '#6e6e79',

        // Accents. `blue` is the primary action colour; the rest carry
        // consistent status meaning across the app (see STATUS_MEANING below).
        blue: '#3d82ff',
        mag: '#ff3cab',
        green: '#00d59a',
        gold: '#ffae00',
        purple: '#9364ff',
        cyan: '#00c7df',
        red: '#ff4f63',
        orange: '#ff783d',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Arial', 'sans-serif'],
        cond: ['Arial Narrow', 'Roboto Condensed', 'Impact', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        panel: '0 18px 55px rgba(0,0,0,.35)',
        glow: '0 0 0 1px rgba(61,130,255,.35), 0 18px 55px rgba(61,130,255,.18)',
      },
      maxWidth: {
        shell: '1280px',
      },
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
  plugins: [],
};

/**
 * STATUS_MEANING — kept consistent everywhere so a colour always reads the same:
 *   green  — within SLA, consented, verified, won
 *   gold   — approaching breach, awaiting review, pending evidence
 *   red    — breached, suppressed, rejected, lost
 *   blue   — primary action, active selection
 *   purple — AI-generated or AI-assisted, pending human review
 *   cyan   — provenance and lineage
 *   orange — imported but unresolved
 */
