import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: vi.fn(), update: vi.fn(), capture: vi.fn() }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@/lib/cloud/onboarding', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/cloud/onboarding')>(), updateOnboardingState: mocks.update }));
vi.mock('@/lib/cloud/product-analytics', () => ({ captureProductEvent: mocks.capture }));
import { POST } from '@/app/api/onboarding/route';
const request = (body: unknown) => new Request('https://app.adport.test/api/onboarding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const principal = { organizationId: 'current-project', userId: 'user', role: 'owner', scopes: [] };
beforeEach(() => { vi.resetAllMocks(); mocks.session.mockResolvedValue(principal); mocks.update.mockResolvedValue(undefined); });

describe('skippable project setup', () => {
  it('keeps the current step when leaving setup and distinguishes skips from completion', async () => {
    const response = await POST(request({ currentStep: 'accounts', skip: true, setupKind: 'new_project' }));
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(principal, expect.objectContaining({ currentStep: 'accounts', skip: true }));
    expect(mocks.capture).toHaveBeenCalledWith(principal, expect.objectContaining({ complete: false, skipped: true, setup_kind: 'new_project' }));
  });
  it.each([{ currentStep: 'complete', skip: true }, { currentStep: 'complete', skip: true, complete: true }, { currentStep: 'accounts', complete: true }])('rejects ambiguous completion: %j', async body => {
    expect((await POST(request(body))).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('uses only the authenticated current project and retains admin enforcement', async () => {
    mocks.update.mockRejectedValue(new Error('Owner or admin access is required.'));
    expect((await POST(request({ currentStep: 'connect', skip: true, organizationId: 'another-project' }))).status).toBe(403);
    expect(mocks.update).toHaveBeenCalledWith(principal, { currentStep: 'connect', skip: true });
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
