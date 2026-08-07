import type { Meta, StoryObj } from '@storybook/react';
import { Drawer } from './Drawer';
import { Callout } from './inputs';

/**
 * The side drawer — the same guarantees as Modal (focus trap, Escape, scroll
 * lock), for content the operator reads ALONGSIDE the record rather than
 * instead of it. Data Credits and provenance detail are the two real uses.
 */
const meta: Meta<typeof Drawer> = {
  title: 'Overlays/Drawer',
  component: Drawer,
  args: {
    open: true,
    onClose: () => undefined,
    title: 'Data Credits',
    subtitle: 'Spend against this tenant’s enrichment allowance',
    children: (
      <dl className="space-y-3 text-sm">
        <div className="flex justify-between"><dt className="text-soft">Remaining</dt><dd className="tabular-nums text-text">4,120</dd></div>
        <div className="flex justify-between"><dt className="text-soft">Spent this cycle</dt><dd className="tabular-nums text-text">880</dd></div>
        <div className="flex justify-between"><dt className="text-soft">Resets</dt><dd className="text-text">1 Aug 2026</dd></div>
      </dl>
    ),
  },
};
export default meta;

type Story = StoryObj<typeof Drawer>;

export const Default: Story = {
  args: { footer: <button type="button" className="lf-btn-primary px-4 py-2">Top up</button> },
};

export const Loading: Story = {
  args: {
    children: (
      <div role="status" aria-busy="true" aria-label="Loading balance" className="space-y-2">
        {[0, 1, 2].map((i) => <div key={i} className="h-6 motion-safe:animate-pulse rounded-lg bg-panel2" />)}
      </div>
    ),
  },
};

export const Empty: Story = {
  args: { children: <p className="py-8 text-center text-sm text-soft">No credit activity in this cycle.</p> },
};

export const ErrorState: Story = {
  args: {
    children: <Callout role="blocked" title="Balance unavailable">The credits service did not answer. Your balance is unknown, not zero.</Callout>,
  },
};

export const PermissionDenied: Story = {
  args: {
    children: <Callout role="warning" title="Billing is not visible to you">Credit balances require the billing.view capability.</Callout>,
    // No top-up button: the action is withheld with the reason, not disabled.
    footer: undefined,
  },
};

export const Dense: Story = {
  args: {
    title: 'Provenance',
    children: (
      <ul className="divide-y divide-line text-xs">
        {Array.from({ length: 20 }, (_, i) => (
          <li key={i} className="flex justify-between py-2">
            <span className="text-muted">Field {i + 1}</span>
            <span className="text-soft">USER_PROVIDED</span>
          </li>
        ))}
      </ul>
    ),
  },
};
