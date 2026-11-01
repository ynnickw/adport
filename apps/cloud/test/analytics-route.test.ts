import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ principal: vi.fn(), preference: vi.fn(), set: vi.fn(), capture: vi.fn(), limit: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: () => ({ ADPORT_CLOUD_BASE_URL: 'https://app.adport.test' }) }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.principal }));
vi.mock('@/lib/cloud/repository', () => ({ enforceRateLimit: mocks.limit }));
vi.mock('@/lib/cloud/product-analytics', () => ({ analyticsConfig: () => ({}), analyticsPreference: mocks.preference, setAnalyticsPreference: mocks.set, captureProductEvent: mocks.capture }));
import { GET, POST } from '@/app/api/analytics/route';

describe('analytics preferences endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.principal.mockResolvedValue({ userId: 'real-session-user', organizationId: 'authorized-project' });
    mocks.preference.mockResolvedValue(null); mocks.limit.mockResolvedValue(true);
  });
  const request = (body: unknown, origin = 'https://app.adport.test') => new Request('https://app.adport.test/api/analytics', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('requires a session to read or change preferences', async () => {
    mocks.principal.mockRejectedValue(new Error('Authentication required'));
    expect((await GET()).status).toBe(401);
    expect((await POST(request({ action: 'preference', enabled: true }))).status).toBe(401);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('rejects cross-site requests, arbitrary events, and spoofed identities', async () => {
    expect((await POST(request({ action: 'preference', enabled: true }, 'https://other.test'))).status).toBe(403);
    expect((await POST(request({ action: 'page', page: 'secret-campaign' }))).status).toBe(400);
    expect((await POST(request({ action: 'preference', enabled: true, userId: 'victim' }))).status).toBe(400);
    expect(mocks.set).not.toHaveBeenCalled(); expect(mocks.capture).not.toHaveBeenCalled();
  });
  it('persists the session user choice and emits no withdrawal event', async () => {
    expect((await POST(request({ action: 'preference', enabled: false }))).status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith('real-session-user', false);
    expect(mocks.capture).not.toHaveBeenCalled();
    await POST(request({ action: 'preference', enabled: true }));
    expect(mocks.capture).toHaveBeenCalledWith({ userId: 'real-session-user', organizationId: 'authorized-project' }, { event: 'analytics_enabled' });
  });
});
