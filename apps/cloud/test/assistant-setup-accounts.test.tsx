// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantConnect } from '@/components/assistant-connect';

beforeEach(() => { vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([
  { authorized: false, hasAccounts: false, canManage: true, heading: 'Connect ChatGPT', showAction: false },
  { authorized: true, hasAccounts: false, canManage: true, heading: 'Enable account access', showAction: true },
  { authorized: true, hasAccounts: false, canManage: false, heading: 'Enable account access', showAction: false },
  { authorized: true, hasAccounts: true, canManage: true, heading: 'Try a test read', showAction: false },
])('sets the account action only when setup needs it and the user can manage accounts ($authorized, $hasAccounts, $canManage)', async ({
  authorized, hasAccounts, canManage, heading, showAction,
}) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ authorized, verified: false, hasAccounts, clientName: null })));
  const onStatusChange = vi.fn();
  render(<AssistantConnect baseUrl="https://app.adport.test" projectName="Northstar" canManageAccounts={canManage} onStatusChange={onStatusChange} />);
  await waitFor(() => expect(onStatusChange).toHaveBeenCalled());
  expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
  const action = screen.queryByRole('link', { name: 'Add accounts' });
  if (showAction) expect(action?.getAttribute('href')).toBe('/dashboard/accounts');
  else expect(action).toBeNull();
  if (!canManage) expect(screen.getByText(/Ask a project owner or admin/)).toBeTruthy();
});
