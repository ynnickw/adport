// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OnboardingFlow } from '@/app/onboarding/onboarding-flow';
import type { AssistantConnectionStatus } from '@/lib/cloud/assistant-connection';
import type { OAuthProviderView } from '@/app/dashboard/connections/provider-connections';

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const saveNames = vi.hoisted(() => vi.fn(async (_state: unknown, _form: FormData) => ({ success: 'Workspace names saved.' })));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/app/onboarding/actions', () => ({ saveWorkspaceNamesAction: saveNames }));
vi.mock('@/components/support-widget', () => ({ SupportLauncher: () => null }));
vi.mock('@/components/assistant-connect', () => ({ AssistantConnect: ({ onStatusChange }: { onStatusChange(status: AssistantConnectionStatus): void }) =>
  <button onClick={() => onStatusChange({ authorized: true, verified: true, hasAccounts: true, clientName: 'Fixture' })}>Simulate verified read</button>,
}));
const providers: OAuthProviderView[] = (['google', 'meta', 'apple', 'microsoft', 'linkedin', 'tiktok'] as const).map(id => ({ id, available: true }));
const props = { organizationId: 'project', projectName: 'Northstar', setupKind: 'first_project' as const, canManage: true,
  initialStep: 'welcome' as const, initialAgent: null, baseUrl: 'https://app.example.invalid', providers, connections: [], accounts: [],
  maxActiveAccounts: 3, organizationActiveCount: 0, returnTo: '/dashboard/agents' };

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ updated: true }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('starts a first workspace with independent names and preserves the dashboard destination', async () => {
  render(<OnboardingFlow {...props} initialStep="workspace" workspace={{ organizationName: 'My organization', projectName: 'General' }} />);
  expect(screen.getByRole('heading', { name: 'Name your workspace' })).toBeTruthy();
  expect(screen.getByRole('list', { name: 'Project setup progress' }).querySelector('[aria-current="step"]')?.textContent).toContain('Workspace');
  const organizationName = screen.getByRole('textbox', { name: 'Organization name' });
  const projectName = screen.getByRole('textbox', { name: 'First project name' });
  expect(organizationName).toHaveProperty('value', 'My organization');
  expect(projectName).toHaveProperty('value', 'General');
  fireEvent.change(organizationName, { target: { value: 'Northstar Studio' } });
  fireEvent.change(projectName, { target: { value: 'Paid media' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue to platforms' }));
  await waitFor(() => expect(saveNames).toHaveBeenCalledOnce());
  expect(Object.fromEntries(saveNames.mock.calls[0]![1])).toEqual({
    projectId: 'project', organizationName: 'Northstar Studio', projectName: 'Paid media', return_to: '/dashboard/agents', advance: '1',
  });
});

it('starts at searchable platform selection without writing progress on page load', () => {
  render(<OnboardingFlow {...props} />);
  expect(screen.getByRole('heading', { name: 'Connect a platform' })).toBeTruthy();
  expect(screen.getByRole('list', { name: 'Project setup progress' }).querySelector('[aria-current="step"]')?.textContent).toContain('Platform');
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a platform' }), { target: { value: 'Apple' } });
  expect(screen.getByRole('link', { name: 'Connect Apple Ads' }).getAttribute('href')).toContain('organization_id=project');
  expect(screen.queryByRole('link', { name: 'Connect Google Ads' })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps the current step after a save error and resumes the assistant step on success', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: 'Could not save setup' }, { status: 503 }));
  render(<OnboardingFlow {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect assistant first' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('heading', { name: 'Connect a platform' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Connect assistant first' }));
  expect(await screen.findByRole('heading', { name: 'Connect your assistant' })).toBeTruthy();
  const progress = screen.getByRole('list', { name: 'Project setup progress' });
  expect(progress.querySelector('[aria-current="step"]')?.textContent).toContain('Assistant');
  expect(window.location.pathname + window.location.search).toBe('/onboarding?return_to=%2Fdashboard%2Fagents&step=agent');
  expect(screen.getByRole('button', { name: 'Finish setup' }).hasAttribute('disabled')).toBe(true);
  expect(router.replace).not.toHaveBeenCalled();
});

it('separates leaving setup from completing it after a verified read', async () => {
  const view = render(<OnboardingFlow {...props} initialStep="agent" />);
  fireEvent.click(screen.getByRole('button', { name: 'Set up later' }));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard/agents'));
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({ currentStep: 'agent', selectedAgent: 'chatgpt', setupKind: 'first_project', skip: true });
  view.unmount();
  render(<OnboardingFlow {...props} initialStep="agent" />);
  fireEvent.click(screen.getByRole('button', { name: 'Simulate verified read' }));
  fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
  await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))).toEqual({ currentStep: 'complete', selectedAgent: 'chatgpt', setupKind: 'first_project', complete: true });
});
