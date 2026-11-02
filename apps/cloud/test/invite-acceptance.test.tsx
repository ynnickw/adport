// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), setSession: vi.fn(), updateUser: vi.fn(), selectProject: vi.fn(), createClient: vi.fn() }));
vi.mock('@/lib/supabase/browser', () => ({ createClient: mocks.createClient }));
vi.mock('@/app/dashboard/projects/actions', () => ({ selectProjectAction: mocks.selectProject }));
import { InviteAcceptance } from '@/app/auth/invite/invite-acceptance';

const projectId = 'aa000000-0000-4000-8000-000000000001';
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, '', `/auth/invite?project_id=${projectId}`);
  mocks.createClient.mockImplementation(() => {
    expect(window.location.hash).toBe('');
    return { auth: { getUser: mocks.getUser, setSession: mocks.setSession, updateUser: mocks.updateUser } };
  });
  mocks.getUser.mockResolvedValue({ data: { user: { email: 'member@example.test' } }, error: null });
  mocks.setSession.mockResolvedValue({ error: null });
  mocks.selectProject.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('passwordless invitation acceptance', () => {
  it.each(['email', 'google', 'github'])('lets an existing %s user join without creating or changing a password', async provider => {
    mocks.getUser.mockResolvedValue({ data: { user: { email: 'member@example.test', app_metadata: { provider } } }, error: null });
    const { container } = render(<StrictMode><InviteAcceptance projectId={projectId} /></StrictMode>);
    const join = await screen.findByRole('button', { name: 'Join project' });
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByText('member@example.test')).toBeTruthy();
    fireEvent.click(join);
    await waitFor(() => expect(mocks.selectProject).toHaveBeenCalledTimes(1));
    expect(mocks.selectProject.mock.calls[0]![0].get('projectId')).toBe(projectId);
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    const back = screen.getByRole('link', { name: 'Back to sign in' });
    expect(new URL(back.getAttribute('href')!, window.location.origin).searchParams.get('return_to')).toBe(`/auth/invite?project_id=${projectId}`);
  });

  it('establishes a new invitee session and clears credentials before showing Join', async () => {
    window.history.replaceState(null, '', `${window.location.href}#type=invite&access_token=fixture-access&refresh_token=fixture-refresh`);
    render(<InviteAcceptance projectId={projectId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Join project' }));
    await waitFor(() => expect(mocks.selectProject).toHaveBeenCalledTimes(1));
    expect(mocks.setSession).toHaveBeenCalledWith({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' });
    expect(mocks.setSession.mock.invocationCallOrder[0]).toBeLessThan(mocks.getUser.mock.invocationCallOrder[0]!);
    expect(window.location.hash).toBe('');
    expect(document.body.textContent).not.toContain('fixture-access');
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('waits for user verification before offering project access', async () => {
    mocks.getUser.mockReturnValue(new Promise(() => {}));
    render(<InviteAcceptance projectId={projectId} />);
    expect(screen.getByRole('status').textContent).toContain('Verifying');
    expect(screen.queryByRole('button', { name: 'Join project' })).toBeNull();
    expect(mocks.selectProject).not.toHaveBeenCalled();
  });

  it.each(['#error=access_denied', '#type=recovery&access_token=a&refresh_token=b', '#type=invite&access_token=a'])('rejects an invalid invitation fragment %s', async hash => {
    window.history.replaceState(null, '', window.location.href + hash);
    render(<InviteAcceptance projectId={projectId} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/invalid|incomplete/);
    expect(screen.queryByRole('button')).toBeNull();
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.selectProject).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });

  it('rejects a failed session exchange even if another account was already signed in', async () => {
    window.history.replaceState(null, '', window.location.href + '#type=invite&access_token=a&refresh_token=b');
    mocks.setSession.mockResolvedValue({ error: new Error('expired') });
    render(<InviteAcceptance projectId={projectId} />);
    expect((await screen.findByRole('alert')).textContent).toContain('invalid or expired');
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('requires a verified signed-in user', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    render(<InviteAcceptance projectId={projectId} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Open the invitation link');
    expect(screen.queryByRole('button')).toBeNull();
    expect(mocks.selectProject).not.toHaveBeenCalled();
  });

  it('prevents duplicate submits while joining and allows retry after an access failure', async () => {
    let rejectSelection!: (error: Error) => void;
    mocks.selectProject.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSelection = reject; }));
    render(<InviteAcceptance projectId={projectId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Join project' }));
    expect((await screen.findByRole('button', { name: 'Joining…' }) as HTMLButtonElement).disabled).toBe(true);
    rejectSelection(new Error('private database error'));
    expect((await screen.findByRole('alert')).textContent).toContain('Your project access could not be confirmed');
    expect(document.body.textContent).not.toContain('private database error');
    fireEvent.click(await screen.findByRole('button', { name: 'Join project' }));
    await waitFor(() => expect(mocks.selectProject).toHaveBeenCalledTimes(2));
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});
