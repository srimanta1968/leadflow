import type { Preview } from '@storybook/react';
import '../src/styles/globals.css';

/**
 * Every story renders on the app's real surface colour, from the generated
 * tokens — not on Storybook's default white. A dark-palette design system
 * reviewed on white is reviewed against contrast ratios it will never have.
 */
const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'app',
      values: [
        { name: 'app', value: 'var(--bg)' },
        { name: 'panel', value: 'var(--panel)' },
      ],
    },
    a11y: {
      // Report only — the BUILD-FAILING axe run lives in
      // tests/unit/storybookGate.test.tsx, so the gate cannot be silenced by a
      // browser-only setting somebody flips while debugging.
      element: '#storybook-root',
    },
    controls: { expanded: true },
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-bg p-6 text-text">
        <Story />
      </div>
    ),
  ],
};

export default preview;
