import type { StorybookConfig } from '@storybook/react-vite';

/**
 * Storybook over the design system ONLY.
 *
 * Screens are deliberately out of scope: they compose providers, a router and
 * live fetches, so a story of one is a story of the mocks. The primitives are
 * where "component per state" is a real contract, and they are what the lint
 * gate in tests/unit/designSystemGuard.test.ts forces every screen through.
 *
 * The same story files are the input to tests/unit/storybookGate.test.tsx, which
 * runs axe over every one of them in CI. That is the point of writing them in
 * CSF rather than as ad-hoc fixtures — one definition, rendered by the browser
 * for review and by the test runner for the gate, so a story that looks right in
 * Storybook cannot be a story that never gets audited.
 */
const config: StorybookConfig = {
  stories: ['../src/design-system/**/*.stories.tsx'],
  addons: ['@storybook/addon-essentials', '@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
};

export default config;
