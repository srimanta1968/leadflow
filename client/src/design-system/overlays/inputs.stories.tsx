import type { Meta, StoryObj } from '@storybook/react';
import { Callout, ChoiceGrid, DropZone, Hint, Req, SignatureCanvas, Tabs } from './inputs';

/**
 * The specialised inputs, grouped because they share one module and one purpose:
 * they are the controls a governed flow needs and plain HTML does not provide.
 *
 * Tabs is the meta component because it is the one with a keyboard contract —
 * arrow-key traversal with roving tabindex, asserted for real in
 * tests/unit/overlayAccessibility.test.tsx. The rest are render stories.
 */
const meta: Meta<typeof Tabs> = {
  title: 'Overlays/Inputs',
  component: Tabs,
  args: {
    tabs: [
      { id: 'overview', label: 'Overview', panel: <p className="text-sm text-muted">Overview panel.</p> },
      { id: 'provenance', label: 'Provenance', panel: <p className="text-sm text-muted">Provenance panel.</p> },
      { id: 'audit', label: 'Audit', panel: <p className="text-sm text-muted">Audit panel.</p> },
    ],
  },
};
export default meta;

type Story = StoryObj<typeof Tabs>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    tabs: [
      {
        id: 'overview',
        label: 'Overview',
        panel: (
          <div role="status" aria-busy="true" aria-label="Loading" className="space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="h-6 motion-safe:animate-pulse rounded-lg bg-panel2" />)}
          </div>
        ),
      },
    ],
  },
};

export const Empty: Story = {
  args: { tabs: [{ id: 'overview', label: 'Overview', panel: <p className="py-8 text-center text-sm text-soft">Nothing recorded yet.</p> }] },
};

export const ErrorState: Story = {
  args: {
    tabs: [{ id: 'audit', label: 'Audit', panel: <Callout role="blocked" title="Audit unavailable">The audit log could not be read.</Callout> }],
  },
};

export const PermissionDenied: Story = {
  args: {
    // The tab is absent, not disabled-and-present. A disabled tab advertises a
    // section the operator cannot reach and cannot ask for.
    tabs: [
      { id: 'overview', label: 'Overview', panel: <p className="text-sm text-muted">Overview panel.</p> },
      { id: 'provenance', label: 'Provenance', panel: <Callout role="warning" title="Restricted">Provenance requires the evidence.view capability.</Callout> },
    ],
  },
};

export const Dense: Story = {
  // Eight tabs is Contact 360's real count, and the wrap only misbehaves there.
  args: {
    tabs: Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      label: ['Overview', 'Provenance', 'Audit', 'Consent', 'Activity', 'Deals', 'Tasks', 'Files'][i],
      panel: <p className="text-sm text-muted">Panel {i + 1}.</p>,
    })),
  },
};

/* ------------------------------------------------------- other primitives */

export const Callouts: StoryObj = {
  render: () => (
    <div className="space-y-3">
      <Callout role="info" title="Nothing has been written yet">Review the mapping before committing.</Callout>
      <Callout role="success" title="Linked">The record is now P3 Linked.</Callout>
      <Callout role="warning" title="Consent not recorded">You may store this contact but not message them.</Callout>
      <Callout role="blocked" title="Denied">The policy engine refused: caller lacks pii.reveal.</Callout>
    </div>
  ),
};

export const DropZoneStates: StoryObj = {
  render: () => (
    <div className="space-y-4">
      <div>
        <p className="lf-label">Contacts<Req /></p>
        <DropZone accept=".csv" label="Drop a CSV here" hint="Nothing leaves the browser until you commit" onFile={() => undefined} />
        <Hint>Files are handed to the page, never uploaded on drop.</Hint>
      </div>
      <DropZone accept="image/*" preview label="Drop an image" onFile={() => undefined} />
    </div>
  ),
};

export const ChoiceGridStates: StoryObj = {
  render: () => (
    <ChoiceGrid
      name="Import source"
      value="csv"
      onChange={() => undefined}
      options={[
        { id: 'csv', label: 'CSV file', detail: 'A column-mapped export' },
        { id: 'vcard', label: 'vCard', detail: 'One record per card' },
      ]}
    />
  ),
};

export const Signature: StoryObj = {
  render: () => <SignatureCanvas onSigned={() => undefined} />,
};
