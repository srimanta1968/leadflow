import type { Meta, StoryObj } from '@storybook/react';
import { AssertionTable } from './AssertionTable';
import type { Assertion } from './assertions';

/**
 * The assertion table — the screen where the product's whole claim is either
 * kept or broken, so its states are written out rather than sampled.
 *
 * Every row says where a value came from, how confident the system is, and, when
 * it lost, WHY it lost. The Superseded story exists because the type makes a
 * superseded row without a reason uncompilable; the story is what proves the
 * reason is actually rendered rather than merely required.
 */
const ROWS: Assertion[] = [
  {
    id: 'a1',
    assertion: 'Work email',
    value: 'dana.okafor@northwind.example',
    source: 'Web form submission',
    crosswalkRef: 'SR-40219',
    originClass: 'USER_PROVIDED',
    confidence: 0.98,
    effectiveAt: '2026-07-02T09:14:00Z',
    retrievedAt: '2026-07-02T09:14:03Z',
    evidenceRef: 'EV-88121',
    status: 'Primary',
  },
  {
    id: 'a2',
    assertion: 'Job title',
    value: 'Head of Revenue Operations',
    source: 'Licensed provider',
    originClass: 'LICENSED_THIRD_PARTY',
    confidence: 0.71,
    effectiveAt: '2026-06-18T00:00:00Z',
    retrievedAt: '2026-07-01T02:00:00Z',
    evidenceRef: 'EV-88144',
    status: 'Survives',
  },
  {
    id: 'a3',
    assertion: 'Mobile',
    value: '+44 7700 900123',
    source: 'Partner enrichment',
    originClass: 'PARTNER_PROVIDED',
    // Unscored. The renderer must show this as "—" and NOT as 0%, which would
    // read as "we checked and it is worthless" rather than "nobody scored it".
    confidence: null,
    effectiveAt: null,
    retrievedAt: '2026-07-05T11:20:00Z',
    sensitive: true,
    status: 'Assertion',
  },
  {
    id: 'a4',
    assertion: 'Work email',
    value: 'd.okafor@northwind.example',
    source: 'Imported CSV',
    originClass: 'TENANT_FIRST_PARTY_CRM',
    confidence: 0.44,
    effectiveAt: '2026-03-11T00:00:00Z',
    retrievedAt: '2026-03-11T00:00:00Z',
    status: 'Superseded',
    supersededReason: 'Lower origin-class precedence than a direct form submission',
    supersededBy: 'a1',
  },
];

const meta: Meta<typeof AssertionTable> = {
  title: 'Evidence/AssertionTable',
  component: AssertionTable,
  args: { rows: ROWS, onOpenEvidence: () => undefined },
};
export default meta;

type Story = StoryObj<typeof AssertionTable>;

export const Default: Story = {};

export const Loading: Story = { args: { loading: true } };

export const Empty: Story = { args: { rows: [] } };

export const ErrorState: Story = {
  // The table has no error prop by design — a failed projection read is not a
  // table state, it is a page state, and the design system's home for it is the
  // Callout. This story pins that pairing so the next screen copies it rather
  // than inventing a fourth error panel.
  args: { rows: [] },
  decorators: [
    (Story) => (
      <div className="space-y-4">
        <div role="alert" className="rounded-xl border border-red/40 bg-red/10 p-4">
          <p className="text-sm font-bold text-red">Projection unavailable</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            The explained projection could not be read. Nothing below is missing —
            it is unknown.
          </p>
        </div>
        <Story />
      </div>
    ),
  ],
};

export const PermissionDenied: Story = {
  args: {
    // Sensitive values stay masked and there is no reveal handler, so the
    // control is absent rather than present-and-failing. Offering a reveal that
    // 403s teaches operators to click it and wait.
    rows: ROWS.map((r) => ({ ...r, evidenceRef: undefined })),
    onOpenEvidence: undefined,
  },
};

export const Dense: Story = {
  args: { rows: [...ROWS, ...ROWS.map((r) => ({ ...r, id: `${r.id}-b` }))] },
};

export const AllSuperseded: Story = {
  // Every row lost. The reason column is the only thing keeping this readable,
  // and it is the state most likely to be reached during a bad merge.
  args: {
    rows: ROWS.map((r) => ({
      ...r,
      status: 'Superseded' as const,
      supersededReason: 'Superseded by the direct-interaction record',
      supersededBy: 'a1',
    })),
  },
};
