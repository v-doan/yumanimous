import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog';

function setup() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      title="Leave this session?"
      message="Your votes will be removed."
      confirmLabel="Leave"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmDialog', () => {
  it('is an accessible dialog that starts on the safe choice', () => {
    setup();
    expect(screen.getByRole('alertdialog', { name: 'Leave this session?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('confirms', async () => {
    const { onConfirm, onCancel } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels with the button, Escape, or a tap outside', async () => {
    const { onConfirm, onCancel } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('alertdialog').parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a click inside the dialog is not a cancel', async () => {
    const { onCancel } = setup();
    await userEvent.click(screen.getByText('Your votes will be removed.'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  // The bug this replaced: window.confirm() returns false without showing anything
  // in some embedded and in-app browsers, so Leave did nothing.
  it('never relies on window.confirm', async () => {
    const native = vi.spyOn(window, 'confirm');
    const { onConfirm } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(native).not.toHaveBeenCalled();
  });
});
