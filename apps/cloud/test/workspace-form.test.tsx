// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceForm } from '@/components/workspace-form';
import { ToastProvider } from '@/components/toast';
import type { WorkspaceActionState } from '@/app/dashboard/projects/actions';

afterEach(cleanup);

it('preserves the draft on a failed save and exposes a single busy action', async () => {
  let respond!: (result: WorkspaceActionState) => void;
  const action = vi.fn((_state: WorkspaceActionState, form: FormData) => {
    expect(form.get('name')).toBe('New name');
    return new Promise<WorkspaceActionState>(resolve => { respond = resolve; });
  });
  render(<WorkspaceForm action={action}><label>Name<input name="name" defaultValue="Existing name" /></label></WorkspaceForm>);
  const name = screen.getByRole('textbox', { name: 'Name' });
  fireEvent.change(name, { target: { value: 'New name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  const pending = await screen.findByRole('button', { name: 'Saving…' });
  expect(pending).toHaveProperty('disabled', true);
  expect(pending.getAttribute('aria-busy')).toBe('true');
  fireEvent.click(pending);
  expect(action).toHaveBeenCalledOnce();
  await act(async () => respond({ error: 'Try another name' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Try another name');
  expect(name).toHaveProperty('value', 'New name');
  expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);
});

it('clears an invite field only after a confirmed success', async () => {
  let respond!: (result: WorkspaceActionState) => void;
  const action = vi.fn(() => new Promise<WorkspaceActionState>(resolve => { respond = resolve; }));
  render(<ToastProvider><WorkspaceForm action={action} label="Invite" resetOnSuccess><label>Email<input name="email" /></label></WorkspaceForm></ToastProvider>);
  const email = screen.getByRole('textbox', { name: 'Email' });
  fireEvent.change(email, { target: { value: 'test@example.invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
  expect(email).toHaveProperty('value', 'test@example.invalid');
  await act(async () => respond({ success: 'Invited' }));
  expect(screen.getByRole('status')).toHaveProperty('textContent', expect.stringContaining('Invited'));
  expect(email).toHaveProperty('value', '');
});
