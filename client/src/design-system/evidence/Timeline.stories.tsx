import type { Meta, StoryObj } from '@storybook/react';
import { Timeline, type TimelineEntry } from './Timeline';

/**
 * The governed activity timeline.
 *
 * A deny entry MUST carry its reason. An audit trail that records "denied" with
 * no reason is worse than none: it proves a decision happened and hides what it
 * was, which is precisely the question anybody reading the timeline is asking.
 */
const ENTRIES: TimelineEntry[] = [
  {
    id: 't1',
    summary: 'Capture received from web form',
    actor: 'system',
    reference: 'SR-40219',
    at: '2026-07-02T09:14:03Z',
  },
  {
    id: 't2',
    summary: 'Linked to Dana Okafor',
    actor: 'j.mensah@leadflow.example',
    reference: 'EV-88121',
    at: '2026-07-02T09:31:44Z',
    decision: { effect: 'permit', reason: 'Direct form submission, origin class USER_PROVIDED' },
  },
  {
    id: 't3',
    summary: 'Reveal of mobile number requested',
    actor: 'r.silva@leadflow.example',
    reference: 'EV-88144',
    at: '2026-07-03T14:02:10Z',
    decision: { effect: 'deny', reason: 'Caller lacks the pii.reveal capability' },
  },
  {
    id: 't4',
    summary: 'Export of the lead queue requested',
    actor: 'r.silva@leadflow.example',
    reference: 'EX-1180',
    at: '2026-07-04T08:45:00Z',
    decision: { effect: 'requires_approval', reason: 'Exports over 500 rows need a manager' },
  },
];

const meta: Meta<typeof Timeline> = {
  title: 'Evidence/Timeline',
  component: Timeline,
  args: { entries: ENTRIES },
};
export default meta;

type Story = StoryObj<typeof Timeline>;

export const Default: Story = {};

export const Loading: Story = {
  // Deliberately not a spinner over stale entries: a timeline that shows four
  // events while fetching a fifth looks complete, and the operator reads it as
  // "nothing else happened".
  args: { entries: [] },
};

export const Empty: Story = { args: { entries: [] } };

export const ErrorState: Story = {
  args: { entries: ENTRIES.slice(0, 1) },
  decorators: [
    (Story) => (
      <div className="space-y-4">
        <div role="alert" className="rounded-xl border border-red/40 bg-red/10 p-4 text-sm text-red">
          Only the first page loaded. Later events are unknown, not absent.
        </div>
        <Story />
      </div>
    ),
  ],
};

export const PermissionDenied: Story = {
  args: {
    entries: ENTRIES.map((e) => ({ ...e, actor: 'redacted', reference: '—' })),
  },
};

export const Dense: Story = {
  args: {
    entries: Array.from({ length: 12 }, (_, i) => ({
      ...ENTRIES[i % ENTRIES.length],
      id: `dense-${i}`,
    })),
  },
};

export const DecisionsOnly: Story = {
  args: { entries: ENTRIES.filter((e) => e.decision) },
};
