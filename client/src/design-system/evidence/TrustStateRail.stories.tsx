import type { Meta, StoryObj } from '@storybook/react';
import { TrustStateRail } from './TrustStateRail';

/**
 * The P0–P4 trust ladder plus Consent.
 *
 * The story that earns its place is ConsentBlocked: a record fully verified to
 * P4 whose consent node is blocked. That combination is exactly why Consent sits
 * ALONGSIDE the ladder rather than inside it, and a rail that renders it as
 * "nearly complete" would imply a permission nobody granted.
 */
const meta: Meta<typeof TrustStateRail> = {
  title: 'Evidence/TrustStateRail',
  component: TrustStateRail,
  args: { onSelect: () => undefined },
};
export default meta;

type Story = StoryObj<typeof TrustStateRail>;

export const Default: Story = {
  args: {
    states: {
      P0_CAPTURED: 'reached',
      P1_NORMALIZED: 'reached',
      P2_CANDIDATE: 'current',
      P3_LINKED: 'pending',
      P4_DIRECT: 'pending',
      CONSENT: 'pending',
    },
    evidence: { P0_CAPTURED: 'EV-88121', P1_NORMALIZED: 'EV-88122' },
  },
};

export const Loading: Story = {
  // Nothing known yet. Every node pending is the honest rendering — defaulting
  // P0 to reached because "it must have been captured" is the system asserting
  // something it has not read.
  args: { states: {} },
};

export const Empty: Story = {
  args: { states: { P0_CAPTURED: 'current' } },
};

export const ErrorState: Story = {
  args: { states: { P0_CAPTURED: 'reached', P1_NORMALIZED: 'blocked' } },
};

export const PermissionDenied: Story = {
  // No onSelect: the nodes render as text rather than buttons, so there is no
  // control that looks actionable and is not.
  args: {
    states: { P0_CAPTURED: 'reached', P1_NORMALIZED: 'reached', P2_CANDIDATE: 'current' },
    onSelect: undefined,
  },
};

export const Dense: Story = {
  args: {
    states: {
      P0_CAPTURED: 'reached',
      P1_NORMALIZED: 'reached',
      P2_CANDIDATE: 'reached',
      P3_LINKED: 'reached',
      P4_DIRECT: 'current',
      CONSENT: 'reached',
    },
  },
};

export const ConsentBlocked: Story = {
  args: {
    states: {
      P0_CAPTURED: 'reached',
      P1_NORMALIZED: 'reached',
      P2_CANDIDATE: 'reached',
      P3_LINKED: 'reached',
      P4_DIRECT: 'reached',
      // Verified all the way, and still must not be contacted.
      CONSENT: 'blocked',
    },
    evidence: { CONSENT: 'EV-90007' },
  },
};
