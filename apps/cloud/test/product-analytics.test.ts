import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sql: vi.fn(), after: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: () => mocks.sql }));
vi.mock('next/server', () => ({ after: mocks.after }));
import { analyticsConfig, analyticsId, captureProductEvent, deliverProductEvent } from '@/lib/cloud/product-analytics';
import { analyticsPage } from '@/lib/analytics-pages';
import type { ProductEvent } from '@/lib/analytics-events';

describe('optional product analytics', () => {
  const principal = { userId: 'private-user-id', organizationId: 'private-project-id' };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('POSTHOG_ENABLED', 'true'); vi.stubEnv('POSTHOG_PROJECT_TOKEN', 'phc_test');
    vi.stubEnv('POSTHOG_HOST', 'https://us.i.posthog.com'); vi.stubEnv('POSTHOG_ID_SALT', 'independent-test-salt-with-at-least-32-characters');
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'staging'); vi.stubEnv('VERCEL_ENV', 'preview');
    mocks.sql.mockResolvedValue([{ organizationId: 'private-company-id', role: 'owner', plan: 'agency' }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('sends only allowed properties and domain-separated pseudonymous identities', async () => {
    await deliverProductEvent(principal, { event: 'tool_completed', category: 'report', surface: 'mcp' });
    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://us.i.posthog.com/i/v0/e/');
    const body = JSON.parse(String(options?.body));
    expect(body.event).toBe('adport_tool_completed');
    expect(body.properties).toMatchObject({ category: 'report', surface: 'mcp', role: 'owner', plan: 'agency', environment: 'staging', $process_person_profile: false, $geoip_disable: true });
    expect(String(options?.body)).not.toMatch(/private-(user|project|company)-id/);
    expect(options?.headers).toEqual({ 'content-type': 'application/json' });
    expect(analyticsId('salt', 'user', 'same')).not.toBe(analyticsId('salt', 'project', 'same'));
  });

  it('rejects extra properties rather than forwarding arbitrary data', async () => {
    await deliverProductEvent(principal, { event: 'analytics_enabled', email: 'never-send@example.test' } as ProductEvent);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends nothing without current consent and membership, or for API keys without a user', async () => {
    mocks.sql.mockResolvedValue([]);
    await deliverProductEvent(principal, { event: 'analytics_enabled' });
    await deliverProductEvent({ organizationId: principal.organizationId }, { event: 'analytics_enabled' });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it('fails closed for incomplete config, wrong hosts, preview contamination, and excluded workspaces', async () => {
    vi.stubEnv('POSTHOG_HOST', 'https://attacker.test');
    expect(analyticsConfig()).toBeUndefined();
    vi.stubEnv('POSTHOG_HOST', 'https://us.i.posthog.com'); vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    expect(analyticsConfig()).toBeUndefined();
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'staging'); vi.stubEnv('POSTHOG_EXCLUDED_PROJECT_IDS', principal.organizationId);
    await deliverProductEvent(principal, { event: 'analytics_enabled' });
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv('POSTHOG_ENABLED', 'false');
    captureProductEvent(principal, { event: 'analytics_enabled' });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('checks consent at delivery and never lets analytics failures fail product work', async () => {
    captureProductEvent(principal, { event: 'analytics_enabled' });
    expect(fetch).not.toHaveBeenCalled();
    mocks.sql.mockResolvedValue([]); // Consent withdrawn while work was queued.
    await mocks.after.mock.calls[0]![0]();
    expect(fetch).not.toHaveBeenCalled();
    mocks.sql.mockRejectedValue(new Error('database detail must not leak'));
    await expect(deliverProductEvent(principal, { event: 'analytics_enabled' })).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith('Product analytics delivery unavailable');
    mocks.after.mockImplementation(() => { throw new Error('no request context'); });
    expect(() => captureProductEvent(principal, { event: 'analytics_enabled' })).not.toThrow();
  });

  it('deduplicates billing delivery without sending Stripe identifiers', async () => {
    await deliverProductEvent(principal, { event: 'subscription_status_changed', subscription_status: 'active', target_plan: 'agency' }, undefined, 'evt_private');
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body));
    expect(body.properties.$insert_id).toHaveLength(64);
    expect(JSON.stringify(body)).not.toContain('evt_private');
  });

  it('only maps explicit safe dashboard routes', () => {
    expect(analyticsPage('/dashboard/projects')).toBe('projects');
    expect(analyticsPage('/dashboard/project/private-id')).toBeUndefined();
    expect(analyticsPage('/oauth/authorize?secret=value')).toBeUndefined();
  });
});
