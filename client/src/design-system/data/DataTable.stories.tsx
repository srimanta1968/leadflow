import type { Meta, StoryObj } from '@storybook/react';
import { DataTable, type Column } from './DataTable';

/**
 * The data primitives, one story per state.
 *
 * These are not decoration. tests/unit/storybookGate.test.tsx renders every
 * story in this file through jsdom and runs axe over it, so a state that is not
 * written down here is a state nobody audits. That is why the awkward ones —
 * error, permission-denied — are present rather than the three easy ones.
 */

interface Lead {
  id: string;
  name: string;
  company: string;
  source: string;
  ageMinutes: number;
}

const COLUMNS: Column<Lead>[] = [
  { key: 'name', header: 'Contact', cell: (r) => r.name, sortValue: (r) => r.name },
  { key: 'company', header: 'Company', cell: (r) => r.company },
  { key: 'source', header: 'Source', cell: (r) => r.source },
  {
    key: 'age',
    header: 'Age',
    align: 'right',
    cell: (r) => `${r.ageMinutes}m`,
    sortValue: (r) => r.ageMinutes,
  },
];

const ROWS: Lead[] = Array.from({ length: 40 }, (_, i) => ({
  id: `lead-${i}`,
  name: `Contact ${i + 1}`,
  company: ['Northwind', 'Contoso', 'Fabrikam', 'Tailspin'][i % 4],
  source: ['Web form', 'Referral', 'Inbound call', 'Campaign'][i % 4],
  ageMinutes: (i * 37) % 2880,
}));

const meta: Meta<typeof DataTable<Lead>> = {
  title: 'Data/DataTable',
  component: DataTable,
  args: { rows: ROWS, columns: COLUMNS, rowKey: (r: Lead) => r.id, caption: 'Lead queue' },
};
export default meta;

type Story = StoryObj<typeof DataTable<Lead>>;

export const Default: Story = {};

export const Loading: Story = { args: { loading: true } };

export const Empty: Story = {
  args: { rows: [], empty: 'No leads match this view. Clear a filter to widen it.' },
};

export const ErrorState: Story = {
  // Rows are [] here too — which is exactly why `error` has to win. Passing both
  // is the realistic case, not a contrived one: a fetch that threw leaves the
  // row state at its initial value.
  args: { rows: [], error: 'Could not read the lead queue. The last attempt failed at 14:02.' },
};

export const PermissionDenied: Story = {
  args: {
    // The rows a viewer IS allowed to see, with the actions withheld and the
    // reason stated. Hiding the row entirely would be a different — and usually
    // wrong — decision: it makes the queue count disagree with the queue.
    rowActions: () => (
      <span className="text-[11px] text-soft" title="Requires the lead.assign capability">
        No permission
      </span>
    ),
  },
};

export const Dense: Story = {
  args: { density: 'dense' },
};

export const Sortable: Story = {
  // The default already sorts; this pins the interaction surface so a change to
  // the header button's accessible name shows up as a story diff.
  args: { onRowClick: () => undefined },
};
