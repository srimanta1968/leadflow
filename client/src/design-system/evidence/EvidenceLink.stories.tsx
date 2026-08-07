import type { Meta, StoryObj } from '@storybook/react';
import { EvidenceLink } from './EvidenceLink';

/**
 * The masked-value control.
 *
 * PermissionDenied here means the reveal control is ABSENT, not present and
 * failing. A button that 403s on click is a worse answer than no button: it
 * teaches operators to click and wait, and it puts a reveal attempt in the audit
 * log for a person who was never going to be allowed one.
 */
const meta: Meta<typeof EvidenceLink> = {
  title: 'Evidence/EvidenceLink',
  component: EvidenceLink,
  args: { label: 'Mobile', masked: '+44 •••• ••0123' },
};
export default meta;

type Story = StoryObj<typeof EvidenceLink>;

export const Default: Story = {
  args: {
    reveal: async () => '+44 7700 900123',
    onOpen: () => undefined,
  },
};

export const Loading: Story = {
  args: {
    // Never resolves, so the in-flight rendering is what the story shows. The
    // reveal is a server round trip through a policy decision, so this state is
    // reached on every single use rather than rarely.
    reveal: () => new Promise<string>(() => undefined),
  },
};

export const Empty: Story = {
  args: { label: 'Mobile', masked: 'Not recorded', reveal: undefined },
};

export const ErrorState: Story = {
  args: {
    reveal: async () => {
      throw new Error('Policy decision unavailable');
    },
  },
};

export const PermissionDenied: Story = {
  args: { reveal: undefined, onOpen: undefined },
};

export const Dense: Story = {
  args: { label: 'SSN', masked: '•••-••-••••', reveal: async () => '123-45-6789' },
};

export const WithEvidenceRecord: Story = {
  args: { reveal: async () => '+44 7700 900123', onOpen: () => undefined },
};
