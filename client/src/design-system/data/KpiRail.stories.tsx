import type { Meta, StoryObj } from '@storybook/react';
import { KpiRail, KpiTile } from './KpiRail';

/**
 * The KPI rail, one story per state.
 *
 * The states that matter here are the ones where the number is NOT a number:
 * loading and unavailable. Both are rendered as an em dash with a caption rather
 * than as 0, because 0 is a real and usually reassuring value — "0 breached" is
 * good news, and showing it while the read is in flight or has failed reports
 * good news the system does not have.
 */
const meta: Meta<typeof KpiTile> = {
  title: 'Data/KpiRail',
  component: KpiTile,
  decorators: [(Story) => <KpiRail><Story /></KpiRail>],
};
export default meta;

type Story = StoryObj<typeof KpiTile>;

export const Default: Story = {
  args: {
    label: 'Unresolved captures',
    value: '128',
    detail: 'oldest 4h 12m',
    role: 'warning',
    delta: { value: '12%', direction: 'up' },
    // Captures piling up is BAD. Without this the arrow would be green.
    higherIsBetter: false,
  },
};

export const Loading: Story = {
  args: { label: 'SLA compliance', value: '—', detail: 'loading' },
};

export const Empty: Story = {
  args: { label: 'Breached', value: '0', detail: 'nothing breached today', role: 'success' },
};

export const ErrorState: Story = {
  args: { label: 'SLA compliance', value: '—', detail: 'unavailable', role: 'blocked' },
};

export const PermissionDenied: Story = {
  args: {
    label: 'Revenue at risk',
    value: '—',
    detail: 'requires the analytics.view capability',
    role: 'info',
  },
};

export const Dense: Story = {
  // No numeral, no delta, no caption — the rail as it appears above a dense
  // triage table, where the tiles are a filter bar rather than a dashboard.
  args: { label: 'Breached', value: '3', active: true, onSelect: () => undefined },
};

export const ImprovingMetric: Story = {
  args: {
    label: 'Median first response',
    value: '6m',
    detail: 'target 10m',
    role: 'success',
    delta: { value: '1m', direction: 'down' },
    higherIsBetter: false,
  },
};
