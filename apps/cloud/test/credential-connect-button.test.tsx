// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderConnections } from '@/app/dashboard/connections/provider-connections';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(['matomo', 'openai', 'gravity'] as const)('connects %s from onboarding and returns to the selection', async provider => {
  const request = vi.fn().mockResolvedValue(Response.json({ redirect: '/account-selection?selection_id=fixture' }));
  vi.stubGlobal('fetch', request);
  const ui = render(<ProviderConnections organizationId="project" projectName="Example" canManage connections={[]}
    oauthProviders={[{ id: provider, available: true }]} returnTo="/onboarding?resume=1" variant="onboarding" />);
  fireEvent.click(ui.getByRole('button', { name: provider === 'matomo' ? 'Connect Matomo' : provider === 'gravity' ? 'Connect Gravity' : 'Connect OpenAI Ads' }));
  if (provider !== 'openai') {
    const dialog = within(ui.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('combobox', { name: /^Connection method: Sign in with/ }));
    fireEvent.click(dialog.getByRole('option', { name: provider === 'matomo' ? 'Use a personal auth token' : 'Use an advertiser API key' }));
  }
  if (provider === 'matomo') fireEvent.change(await ui.findByLabelText('Matomo instance URL'), { target: { value: 'https://analytics.example.test' } });
  fireEvent.change(await ui.findByLabelText(provider === 'matomo' ? 'Auth token' : 'Advertiser API key'), { target: { value: 'test-token' } });
  fireEvent.click(ui.getByRole('button', { name: provider === 'matomo' ? 'Verify and choose sites' : 'Verify and choose account' }));
  await waitFor(() => expect(push).toHaveBeenCalledWith('/account-selection?selection_id=fixture'));
  expect(request.mock.calls[0]?.[0]).toBe('/api/connections/' + provider);
  expect(JSON.parse(request.mock.calls[0]?.[1].body)).toEqual({ organization_id: 'project', return_to: '/onboarding?resume=1',
    ...(provider === 'matomo' ? { url: 'https://analytics.example.test', token_auth: 'test-token' } : { api_key: 'test-token' }) });
});

it('defaults Gravity to spend access and carries the chosen permissions into hosted sign-in', () => {
  const ui = render(<ProviderConnections organizationId="project" projectName="Example" canManage connections={[]}
    oauthProviders={[{ id: 'gravity', available: true }]} returnTo="/onboarding?resume=1" variant="onboarding" />);
  fireEvent.click(ui.getByRole('button', { name: 'Connect Gravity' }));
  const dialog = within(ui.getByRole('dialog'));
  const params = () => new URL(dialog.getByRole('link', { name: 'Continue to Gravity' }).getAttribute('href')!, 'https://app.test').searchParams;
  const permissions = dialog.getByRole('combobox', { name: 'Gravity permissions: Read, edit and change spend' });
  expect(Object.fromEntries(params())).toEqual({
    organization_id: 'project', gravity_access: 'spend', return_to: '/onboarding?resume=1',
  });
  fireEvent.keyDown(permissions, { key: 'Home' });
  fireEvent.keyDown(permissions, { key: 'Enter' });
  expect(params().get('gravity_access')).toBe('read');
  fireEvent.click(permissions);
  fireEvent.click(dialog.getByRole('option', { name: 'Read and edit campaigns' }));
  expect(params().get('gravity_access')).toBe('write');
  const method = dialog.getByRole('combobox', { name: /^Connection method:/ });
  fireEvent.click(method);
  fireEvent.click(dialog.getByRole('option', { name: 'Use an advertiser API key' }));
  fireEvent.click(method);
  fireEvent.click(dialog.getByRole('option', { name: 'Sign in with Gravity' }));
  expect(params().get('gravity_access')).toBe('write');
});
