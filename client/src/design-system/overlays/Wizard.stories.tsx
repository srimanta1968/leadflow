import type { Meta, StoryObj } from '@storybook/react';
import { Wizard, type WizardStepDef } from './Wizard';
import { Callout, ChoiceGrid, DropZone, Hint, Req } from './inputs';

/**
 * The multi-step wizard.
 *
 * Every story uses a DISTINCT wizardId. Progress is persisted to localStorage by
 * design, so two stories sharing an id would show each other's saved answers —
 * and in the test run, story order would decide whether a story rendered its
 * first step or a resume prompt. That is the kind of shared-state flake that
 * gets a suite marked "known flaky" instead of fixed.
 */
function steps(): WizardStepDef[] {
  return [
    {
      label: 'Source',
      render: ({ answers, set }) => (
        <ChoiceGrid
          name="Import source"
          value={(answers.source as string | undefined) ?? null}
          onChange={(id) => set('source', id)}
          options={[
            { id: 'csv', label: 'CSV file', detail: 'A column-mapped export from another system' },
            { id: 'vcard', label: 'vCard', detail: 'Contact cards, one record per card' },
          ]}
        />
      ),
      validate: (a) => (a.source ? [] : ['Choose a source before continuing.']),
    },
    {
      label: 'File',
      render: ({ set }) => (
        <>
          <p className="lf-label">File<Req /></p>
          <DropZone accept=".csv" label="Drop a CSV here" hint="Nothing is uploaded until you commit" onFile={(f) => set('file', f.name)} />
          <Hint>The file itself is never saved with your progress — only your answers.</Hint>
        </>
      ),
    },
    {
      label: 'Review',
      render: ({ answers }) => (
        <Callout role="info" title="Ready to commit">
          Source: {String(answers.source ?? '—')}. Nothing has been written yet.
        </Callout>
      ),
    },
  ];
}

const meta: Meta<typeof Wizard> = {
  title: 'Overlays/Wizard',
  component: Wizard,
  args: { steps: steps(), onComplete: () => undefined, onCancel: () => undefined },
};
export default meta;

type Story = StoryObj<typeof Wizard>;

export const Default: Story = { args: { wizardId: 'story:wizard:default' } };

export const Loading: Story = {
  args: {
    wizardId: 'story:wizard:loading',
    steps: [
      {
        label: 'Source',
        render: () => (
          <div role="status" aria-busy="true" aria-label="Loading sources" className="space-y-2">
            {[0, 1].map((i) => <div key={i} className="h-16 motion-safe:animate-pulse rounded-xl bg-panel2" />)}
          </div>
        ),
      },
    ],
  },
};

export const Empty: Story = {
  args: {
    wizardId: 'story:wizard:empty',
    steps: [
      {
        label: 'Source',
        render: () => <p className="py-8 text-center text-sm text-soft">No import sources are configured for this tenant.</p>,
      },
    ],
  },
};

export const ErrorState: Story = {
  args: {
    wizardId: 'story:wizard:error',
    steps: [
      {
        label: 'Source',
        render: () => <Callout role="blocked" title="Import is unavailable">The import service did not answer. Your progress is saved and you can resume.</Callout>,
      },
    ],
  },
};

export const PermissionDenied: Story = {
  args: {
    wizardId: 'story:wizard:denied',
    // No onCancel and a single terminal step: there is nothing here to commit,
    // so there is no Cancel/Continue pair implying there might be.
    onCancel: undefined,
    steps: [
      {
        label: 'Source',
        render: () => <Callout role="warning" title="Importing is not available to you">Bulk import requires the contact.import capability.</Callout>,
      },
    ],
  },
};

export const Dense: Story = {
  args: {
    wizardId: 'story:wizard:dense',
    // Ten steps is the real shape from the mockup. The stepper has to stay
    // readable when it wraps, which only shows up at this count.
    steps: Array.from({ length: 10 }, (_, i) => ({
      label: `Step ${i + 1}`,
      render: () => <p className="text-sm text-muted">Step {i + 1} body.</p>,
    })),
  },
};

export const ValidationBlocked: Story = {
  args: {
    wizardId: 'story:wizard:validation',
    steps: [
      {
        label: 'Source',
        render: () => <p className="text-sm text-muted">Continue without choosing, to see the blocking reason.</p>,
        validate: () => ['Choose a source before continuing.'],
      },
      { label: 'Review', render: () => <p>Never reached.</p> },
    ],
  },
};
