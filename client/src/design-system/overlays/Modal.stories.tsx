import type { Meta, StoryObj } from '@storybook/react';
import { Modal } from './Modal';
import { Callout } from './inputs';

/**
 * The one modal. Three dialogs in this app previously shipped with no focus
 * trap, no Escape and no scroll lock; every state below runs through the single
 * implementation that has all three, and tests/unit/overlayAccessibility.test.tsx
 * drives those behaviours with real key presses.
 *
 * `open` is fixed true in every story — a story of a closed modal renders
 * nothing, which reviews as "fine" and audits as nothing.
 */
const meta: Meta<typeof Modal> = {
  title: 'Overlays/Modal',
  component: Modal,
  args: {
    open: true,
    onClose: () => undefined,
    title: 'Link this capture',
    subtitle: 'A governed decision — the reason is recorded against the record',
    children: <p className="text-sm text-muted">Body content.</p>,
  },
};
export default meta;

type Story = StoryObj<typeof Modal>;

export const Default: Story = {
  args: {
    footer: (
      <>
        <button type="button" className="lf-btn-secondary px-4 py-2">Cancel</button>
        <button type="button" className="lf-btn-primary px-4 py-2">Link record</button>
      </>
    ),
  },
};

export const Loading: Story = {
  args: {
    children: (
      <div role="status" aria-busy="true" aria-label="Loading candidates" className="space-y-2">
        {/* motion-safe, so the skeleton stops moving under prefers-reduced-motion. */}
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-8 motion-safe:animate-pulse rounded-lg bg-panel2" />
        ))}
      </div>
    ),
  },
};

export const Empty: Story = {
  args: {
    title: 'Link this capture',
    children: <p className="py-8 text-center text-sm text-soft">No candidate records matched.</p>,
  },
};

export const ErrorState: Story = {
  args: {
    children: <Callout role="blocked" title="Could not read candidates">The resolver did not answer. Nothing has been linked.</Callout>,
  },
};

export const PermissionDenied: Story = {
  args: {
    // The confirm button is GONE rather than disabled. A disabled primary with
    // no explanation is the most common way a permission failure gets read as a
    // broken screen.
    children: <Callout role="warning" title="You cannot link records">Linking requires the contact.link capability. Ask an administrator, or send this to a colleague who has it.</Callout>,
    footer: <button type="button" className="lf-btn-secondary px-4 py-2">Close</button>,
  },
};

export const Dense: Story = {
  args: {
    size: 'xl',
    children: (
      <div className="grid grid-cols-3 gap-3 text-xs text-muted">
        {Array.from({ length: 24 }, (_, i) => (
          <div key={i} className="rounded-lg border border-line p-3">Field {i + 1}</div>
        ))}
      </div>
    ),
  },
};

export const SmallSize: Story = { args: { size: 'sm' } };

export const LargeSize: Story = { args: { size: 'lg' } };

export const MustBeAnswered: Story = {
  // dismissable=false removes the close control AND ignores Escape. A governed
  // confirmation that Escape dismisses is not a confirmation.
  args: {
    dismissable: false,
    title: 'Confirm irreversible merge',
    subtitle: 'This cannot be undone from the interface',
    footer: (
      <>
        <button type="button" className="lf-btn-secondary px-4 py-2">Keep both</button>
        <button type="button" className="lf-btn-primary px-4 py-2">Merge</button>
      </>
    ),
  },
};
