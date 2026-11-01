import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, closeDbForTests } from '@/lib/db';
import { resolveMembership } from '@/lib/cloud/repository';
import { createProject } from '@/lib/cloud/workspaces';
import { analyticsPreference, setAnalyticsPreference, deliverProductEvent } from '@/lib/cloud/product-analytics';

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

describeDatabase('analytics consent with real database permissions', () => {
  let userId: string; let projectId: string; let clientProjectId: string;
  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({ email: `analytics-${randomUUID()}@example.test`, password: 'Local-Analytics-Test-0nly!', email_confirm: true });
    if (error || !data.user) throw error ?? new Error('Could not create local test user');
    userId = data.user.id; projectId = (await resolveMembership(userId)).organizationId;
    clientProjectId = await createProject(userId, projectId, 'Local analytics client');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  afterAll(async () => {
    if (clientProjectId) await db()`delete from public.organizations where id = ${clientProjectId}`;
    if (projectId) await db()`delete from public.organizations where id = ${projectId}`;
    if (userId) {
      await admin.auth.admin.deleteUser(userId);
      expect(await analyticsPreference(userId)).toBeNull();
    }
    await closeDbForTests();
  });

  it('defaults to no consent, persists a choice, and keeps preferences private', async () => {
    expect(await analyticsPreference(userId)).toBeNull();
    const [permissions] = await db()<Array<{ anon: boolean; authenticated: boolean }>>`select
      has_table_privilege('anon', 'private.product_analytics_preferences', 'select') as anon,
      has_table_privilege('authenticated', 'private.product_analytics_preferences', 'select') as authenticated`;
    expect(permissions).toEqual({ anon: false, authenticated: false });
    await setAnalyticsPreference(userId, true);
    expect(await analyticsPreference(userId)).toBe(true);
  });

  it('links company activity across projects and stops immediately after withdrawal', async () => {
    vi.stubEnv('POSTHOG_ENABLED', 'true'); vi.stubEnv('POSTHOG_PROJECT_TOKEN', 'phc_local_test');
    vi.stubEnv('POSTHOG_HOST', 'https://us.i.posthog.com'); vi.stubEnv('POSTHOG_ID_SALT', 'test-only-salt-with-at-least-32-characters');
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'local'); vi.stubEnv('VERCEL_ENV', '');
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await deliverProductEvent({ userId, organizationId: projectId }, { event: 'analytics_enabled' });
    await deliverProductEvent({ userId, organizationId: clientProjectId }, { event: 'project_created' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls.map(call => JSON.parse(call[1].body));
    expect(first.properties.organization_key).toBe(second.properties.organization_key);
    expect(first.properties.project_key).not.toBe(second.properties.project_key);
    expect(first.distinct_id).toBe(second.distinct_id);
    await setAnalyticsPreference(userId, false);
    await deliverProductEvent({ userId, organizationId: projectId }, { event: 'analytics_enabled' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await setAnalyticsPreference(userId, true);
    await deliverProductEvent({ userId, organizationId: randomUUID() }, { event: 'analytics_enabled' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
