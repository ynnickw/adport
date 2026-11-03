// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/app/login/email-link/actions', () => ({ requestEmailLink: mocks.request }));
vi.mock('@/app/login/actions', () => ({ signIn: vi.fn(), signUp: vi.fn(), signInWithSocialProvider: vi.fn() }));
import { EmailLinkForm } from '@/app/login/email-link/email-link-form';
import EmailLinkPage from '@/app/login/email-link/page';
import { AuthScreen } from '@/components/auth-screen';

beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

describe('returning without a password', () => {
  it('offers email-link sign in from the existing login screen and preserves the invitation', () => {
    const returnTo = '/auth/invite?project_id=fixture';
    const html = renderToStaticMarkup(<AuthScreen mode="signin" returnTo={returnTo} />);
    expect(html).toContain('/login/email-link?return_to=' + encodeURIComponent(returnTo));
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Continue with GitHub');
    expect(html).toContain('type="password"');
  });

  it('uses a safe return destination in the email-link page', async () => {
    const html = renderToStaticMarkup(await EmailLinkPage({ searchParams: Promise.resolve({ return_to: 'https://evil.example' }) }));
    expect(html).toContain('name="return_to" value="/dashboard"');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('type="password"');
  });

  it('submits only email and destination, disables repeat submissions, and confirms delivery privately', async () => {
    let complete!: (value: { sent: boolean }) => void;
    mocks.request.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const { container } = render(<EmailLinkForm returnTo="/auth/invite?project_id=fixture" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'member@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect((await screen.findByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true);
    const form = mocks.request.mock.calls[0]![1] as FormData;
    expect(form.get('email')).toBe('member@example.test');
    expect(form.get('return_to')).toBe('/auth/invite?project_id=fixture');
    expect(form.has('password')).toBe(false);
    complete({ sent: true });
    expect((await screen.findByRole('status')).textContent).toContain('If an account uses this address');
    expect(container.querySelector('form')).toBeNull();
  });

  it('shows a recoverable error and allows another request', async () => {
    mocks.request.mockResolvedValueOnce({ error: 'Wait a minute and try again.' }).mockResolvedValueOnce({ sent: true });
    render(<EmailLinkForm returnTo="/dashboard" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'member@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Wait a minute and try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('status')).toBeTruthy();
  });
});
