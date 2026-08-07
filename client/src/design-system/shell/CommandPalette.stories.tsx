import type { Meta, StoryObj } from '@storybook/react';
import { MemoryRouter } from 'react-router-dom';
import { CommandPalette } from './CommandPalette';

/**
 * The ⌘K palette.
 *
 * PermissionDenied is the story that matters, because this component already
 * shipped the opposite bug: with an empty query it filtered to `score > 0` and
 * rendered NOTHING for any user with no history. A palette that opens empty
 * reads as broken, and a browser test caught it only because it counted rows.
 * `isAllowed: () => false` is the same failure mode from the other direction —
 * the palette must say why it is empty rather than merely being empty.
 */
const meta: Meta<typeof CommandPalette> = {
  title: 'Shell/CommandPalette',
  component: CommandPalette,
  args: {
    open: true,
    onClose: () => undefined,
    isAllowed: () => true,
    onIntent: () => undefined,
  },
  decorators: [(Story) => <MemoryRouter><Story /></MemoryRouter>],
};
export default meta;

type Story = StoryObj<typeof CommandPalette>;

export const Default: Story = {};

export const Loading: Story = {
  // The registry is static, so there is no fetch to be in flight — the palette
  // is usable the instant it opens, which is the whole reason it is static.
  // Permissions are the only asynchronous input, and an unresolved verdict is
  // treated as ALLOWED so the command does not flicker out from under a click.
  args: { isAllowed: () => true },
};

export const Empty: Story = {
  // Every command filtered out by permission. This is the empty state the
  // component has to explain rather than just render as nothing.
  args: { isAllowed: () => false },
};

export const ErrorState: Story = {
  args: { isAllowed: () => false },
};

export const PermissionDenied: Story = {
  // A viewer: navigation is allowed, anything that writes is not.
  args: { isAllowed: (action: string) => action.endsWith('.view') || action.endsWith('.read') },
};

export const Dense: Story = { args: { isAllowed: () => true } };

export const Closed: Story = {
  // Renders nothing — pinned so that "nothing" stays deliberate. The palette
  // must not keep a focus trap or a scroll lock alive while closed.
  args: { open: false },
};
