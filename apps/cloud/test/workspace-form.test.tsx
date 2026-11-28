// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceForm } from '@/components/workspace-form';
import { InviteProfileField } from '@/components/invite-profile-field';
import { MemberRoleField } from '@/components/team-access-guide';
import { ToastProvider } from '@/components/toast';
import type { WorkspaceActionState } from '@/app/dashboard/projects/actions';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

it('submits a selected existing profile by email and clears it only after confirmed success', async () => {
  const fetch = vi.fn(async () => Response.json({ profiles: [
    { displayName: 'Alex Rivera', email: 'alex@example.invalid', avatarUrl: 'https://avatars.githubusercontent.com/u/100', alreadyHasAccess: false },
    { displayName: 'Alex Smith', email: 'smith@example.invalid', avatarUrl: null, alreadyHasAccess: true },
  ] }));
  vi.stubGlobal('fetch', fetch);
  let respond!: (result: WorkspaceActionState) => void;
  const action = vi.fn((_state: WorkspaceActionState, form: FormData) => {
    expect(form.get('email')).toBe('alex@example.invalid');
    return new Promise<WorkspaceActionState>(resolve => { respond = resolve; });
  });
  render(<ToastProvider><WorkspaceForm action={action} label="Invite" resetOnSuccess>
    <InviteProfileField scope="organization" targetId="organization" />
  </WorkspaceForm></ToastProvider>);
  const email = screen.getByRole('textbox', { name: 'Name or email' });
  fireEvent.change(email, { target: { value: 'Alex' } });
  const profile = await screen.findByRole('button', { name: /Alex Rivera/ });
  expect(profile.querySelector('img')?.getAttribute('src')).toBe('https://avatars.githubusercontent.com/u/100');
  expect(screen.getByText('Already has access')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Alex Smith/ })).toBeNull();
  expect(fetch).toHaveBeenCalledWith('/api/members/search', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ scope: 'organization', targetId: 'organization', query: 'Alex' }),
  }));
  fireEvent.keyDown(email, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(profile);
  fireEvent.click(profile);
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
  expect(email).toHaveProperty('value', 'alex@example.invalid');
  await act(async () => respond({ success: 'Member added.' }));
  expect(screen.getByText('Member added.')).toBeTruthy();
  expect(email).toHaveProperty('value', '');
});

it('opens role guidance from keyboard focus and dismisses it without closing the dialog', () => {
  render(<dialog open><MemberRoleField scope="organization" options={[{ value: 'member', label: 'Member' }]} /></dialog>);
  const trigger = screen.getByRole('button', { name: 'Organization roles and project access' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  act(() => trigger.focus());
  const details = screen.getByRole('tooltip');
  expect(details.closest('dialog')).toBe(screen.getByRole('dialog'));
  expect(details.textContent).toContain('Manages billing');
  expect(details.textContent).toContain('Free and read-only');
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  fireEvent(trigger, escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(screen.getByRole('dialog')).toHaveProperty('open', true);
});
