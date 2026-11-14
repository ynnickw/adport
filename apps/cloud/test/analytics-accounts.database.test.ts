import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDbForTests, db } from '@/lib/db';
import { resetEnvForTests } from '@/lib/env';
import { saveAccountSelection, stageAccountSelection } from '@/lib/cloud/account-selection';
import { applyOrganizationPlanLimits } from '@/lib/cloud/billing';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import { createProject, listOrganizationProjects, organizationActiveAccounts } from '@/lib/cloud/workspaces';
import { setOrganizationAdAccountEnabled, syncDiscoveredAccounts, upsertProviderConnection } from '@/lib/cloud/repository';
import type { TenantPrincipal } from '@/lib/cloud/types';

const databaseUrl = process.env.ADPORT_SELECTION_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('analytics accounts do not consume advertising capacity', () => {
  let admin: ReturnType<typeof postgres>;
  const userId = randomUUID();
  let principal: TenantPrincipal;
  let sibling: string;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !['55322', '56322', '58322'].includes(url.port)) throw new Error('Analytics capacity tests require a local Adport database.');
    process.env.SUPABASE_DB_URL = databaseUrl; resetEnvForTests();
    admin = postgres(databaseUrl!, { max: 1 });
    await admin`insert into auth.users (id, email, raw_user_meta_data) values (${userId}, ${`analytics-${userId}@example.test`}, '{}'::jsonb)`;
    const [membership] = await admin`select organization_id from public.organization_memberships where user_id = ${userId}`;
    principal = { organizationId: membership!.organization_id, userId, role: 'owner', scopes: [] };
    sibling = await createProject(userId, principal.organizationId, 'Analytics sibling');
    const connectionId = await upsertProviderConnection({ organizationId: principal.organizationId, userId, provider: 'google', credential: { refreshToken: 'local-fixture' } });
    for (let i = 0; i < 5; i++) await db()`insert into public.organization_ad_accounts (organization_id, connection_id, provider, account_id, name, enabled)
      values (${principal.organizationId}, ${connectionId}, 'google', ${String(i)}, 'Local advertising fixture', ${i < 3})`;
  });
  afterAll(async () => {
    if (principal) {
      await admin`delete from public.organizations where id = ${sibling}`;
      await admin`delete from public.organizations where id = ${principal.organizationId}`;
      await admin`delete from auth.users where id = ${userId}`;
    }
    await closeDbForTests(); await admin?.end();
  });

  it.each(['gtm', 'ga4', 'gsc'] as const)('allows %s selection, activation and discovery at the full ad limit', async provider => {
    const selectionId = randomUUID();
    const connectionId = await upsertProviderConnection({ organizationId: principal.organizationId, userId, provider, credential: { refreshToken: 'local-analytics-fixture' }, selectionId });
    const ids = provider === 'gsc' ? ['sc-domain:example.test', 'https://example.test/'] : ['101', '102'];
    const accounts = ids.map(id => ({ provider, id, name: 'Local analytics fixture' }));
    await stageAccountSelection({ principal, id: selectionId, connectionId, provider, accounts, returnPath: '/dashboard/analytics' });
    const saved = await saveAccountSelection(principal, selectionId, accounts.map(account => account.id), undefined, { maxActiveAccounts: 3, currentPlan: 'Free', currentPlanId: 'reader' });
    expect(saved.returnPath).toContain('/dashboard/analytics?');
    const toggle = (enabled: boolean) => setOrganizationAdAccountEnabled({ principal, provider, accountId: ids[0]!, enabled, maxActiveAccounts: 3, currentPlan: 'Free', recommendedPlan: 'operator' });
    await toggle(false); await toggle(true);
    expect(await syncDiscoveredAccounts({ organizationId: principal.organizationId, connectionId, provider, accounts, maxActiveAccounts: 3 })).toHaveLength(2);
    expect(await organizationActiveAccounts(principal.organizationId)).toBe(3);
    expect(await getOrganizationUsage(principal.organizationId)).toMatchObject({ enabledAccounts: 3 });
    expect((await listOrganizationProjects(userId, principal.organizationId)).find(project => project.id === principal.organizationId)?.enabledAccounts).toBe(3);
    await expect(setOrganizationAdAccountEnabled({ principal, provider: 'google', accountId: '3', enabled: true, maxActiveAccounts: 3, currentPlan: 'Free', recommendedPlan: 'operator' })).rejects.toMatchObject({ code: 'PLAN_LIMIT' });
    await expect(admin`update public.organization_ad_accounts set enabled = true where organization_id = ${principal.organizationId} and provider = 'google' and account_id = '3'`).rejects.toThrow('Organization active account limit');
  });

  it('preserves analytics on downgrade across projects while limiting only advertising accounts', async () => {
    for (const provider of ['gtm', 'ga4', 'gsc'] as const) {
      const connectionId = await upsertProviderConnection({ organizationId: sibling, userId, provider, credential: { refreshToken: 'local-sibling-fixture' } });
      await admin`insert into public.organization_ad_accounts (organization_id, connection_id, provider, account_id, name, enabled)
        values (${sibling}, ${connectionId}, ${provider}, ${provider === 'gsc' ? 'sc-domain:sibling.test' : '103'}, 'Sibling analytics', true)`;
    }
    await admin`update public.organization_subscriptions set plan = 'agency', status = 'active' where organization_id = ${principal.organizationId}`;
    await admin`update public.organization_ad_accounts set enabled = true where organization_id = ${principal.organizationId} and provider = 'google'`;
    await db().begin(sql => applyOrganizationPlanLimits(sql, principal.organizationId, 'reader'));
    const [counts] = await admin`select count(*) filter (where provider = 'google' and enabled)::int as ads,
      count(*) filter (where provider in ('gtm', 'ga4', 'gsc') and enabled)::int as analytics from public.organization_ad_accounts
      where organization_id in (${principal.organizationId}, ${sibling})`;
    expect(counts).toMatchObject({ ads: 3, analytics: 9 });
    expect(await organizationActiveAccounts(sibling)).toBe(3);
    expect(await getOrganizationUsage(sibling)).toMatchObject({ enabledAccounts: 3 });
  });
});
