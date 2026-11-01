import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDbForTests, db } from '@/lib/db';
import { applyPlanToPrincipal, PLANS } from '@/lib/cloud/plans';
import { createProject, saveOrganizationMember } from '@/lib/cloud/workspaces';
import { editingMemberCapacity } from '@/lib/cloud/member-capacity';
import { changeOrganizationMemberRole, inviteOrganizationMember } from '@/lib/cloud/tenant-admin';
import { resolveMembership, setOrganizationAdAccountEnabled, upsertProviderConnection } from '@/lib/cloud/repository';

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;
describeDatabase('editing seats and competitive account allowances', () => {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const users: string[] = [];
  const emails: string[] = [];
  let company: string; let project: string; let otherProject: string;
  const principal = () => ({ organizationId: project, userId: users[0]!, role: 'owner' as const, scopes: [] });
  const save = (user: number, role: 'member' | 'viewer', projects = [project]) => saveOrganizationMember({ actorUserId: users[0]!, organizationId: company, userId: users[user]!, role, projectIds: projects });

  beforeAll(async () => {
    for (let i = 0; i < 5; i++) {
      const email = `pricing-${randomUUID()}@example.test`;
      const { data, error } = await admin.auth.admin.createUser({ email, password: 'Local-Pricing-Test-Passw0rd!', email_confirm: true });
      if (error || !data.user) throw error ?? new Error('Local fixture user failed');
      users.push(data.user.id); emails.push(email);
    }
    company = (await resolveMembership(users[0]!)).organizationId;
    project = await createProject(users[0]!, company, 'Pricing client one');
    otherProject = await createProject(users[0]!, company, 'Pricing client two');
    await db()`update public.organization_subscriptions set plan = 'operator', status = 'active' where organization_id = ${company}`;
  });
  afterAll(async () => {
    if (users.length) {
      await db()`delete from public.organizations where created_by in ${db()(users)} and id <> organization_group_id`;
      await db()`delete from public.organizations where created_by in ${db()(users)}`;
      for (const id of users) await admin.auth.admin.deleteUser(id);
    }
    await closeDbForTests();
  });

  it('allows free client viewers at the editing limit and counts editors once across projects', async () => {
    await save(1, 'member', [project, otherProject]);
    await save(2, 'viewer'); await save(3, 'viewer');
    await inviteOrganizationMember(principal(), emails[4]!, 'viewer');
    expect((await editingMemberCapacity(project)).count).toBe(2);
    const access = await applyPlanToPrincipal({ organizationId: project, userId: users[2]!, scopes: ['tools:read', 'tools:write'] });
    expect(access.role).toBe('viewer'); expect(access.scopes).toEqual(['tools:read']);
    expect((await editingMemberCapacity(project, users[4])).existing).toBe(false);
  });

  it('rejects API and direct-SQL viewer promotions beyond the quota', async () => {
    await expect(save(2, 'member')).rejects.toThrow('editing-member limit');
    await expect(changeOrganizationMemberRole(principal(), users[2]!, 'member')).rejects.toThrow('Organization member limit');
    await expect(db()`update public.organization_group_memberships set role = 'admin'
      where organization_group_id = ${company} and user_id = ${users[3]!}`).rejects.toThrow('Organization member limit');
    expect((await resolveMembership(users[2]!, project)).role).toBe('viewer');
    expect((await editingMemberCapacity(project)).count).toBe(2);
  });

  it('keeps a seat while another project grants editing, then releases it after the last demotion', async () => {
    await changeOrganizationMemberRole(principal(), users[1]!, 'viewer');
    expect((await editingMemberCapacity(project)).count).toBe(2);
    await changeOrganizationMemberRole({ ...principal(), organizationId: otherProject }, users[1]!, 'viewer');
    expect((await editingMemberCapacity(project)).count).toBe(1);
  });

  it('serializes concurrent promotions into one remaining editing seat', async () => {
    const results = await Promise.allSettled([2, 3].map(user => changeOrganizationMemberRole(principal(), users[user]!, 'member')));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain('Organization member limit');
    expect((await editingMemberCapacity(project)).count).toBe(2);
  });

  for (const id of ['premium', 'agency'] as const) {
    it(`enforces the ${PLANS[id].maxActiveAccounts}-account ${PLANS[id].name} allowance in the API and database`, async () => {
      const plan = PLANS[id]; const max = plan.maxActiveAccounts!;
      await db()`update public.organization_subscriptions set plan = ${id}, status = 'active' where organization_id = ${company}`;
      await db()`update public.organization_ad_accounts set enabled = false where organization_id in (${project}, ${otherProject})`;
      const connection = await upsertProviderConnection({ organizationId: project, userId: users[0]!, provider: 'google', credential: { refreshToken: 'local-pricing-test-only' }, externalLabel: 'Local quota test', scopes: [] });
      for (let i = 0; i <= max; i++) {
        await db()`insert into public.organization_ad_accounts (organization_id, connection_id, provider, account_id, name)
          values (${project}, ${connection}, 'google', ${`pricing-${i}`}, 'Local quota account') on conflict do nothing`;
      }
      const enable = (i: number) => setOrganizationAdAccountEnabled({ principal: principal(), provider: 'google', accountId: `pricing-${i}`, enabled: true, maxActiveAccounts: max, currentPlan: plan.name, recommendedPlan: id === 'premium' ? 'agency' : 'enterprise' });
      for (let i = 0; i < max; i++) await enable(i);
      await expect(enable(max)).rejects.toMatchObject({ code: 'PLAN_LIMIT' });
      await expect(db()`update public.organization_ad_accounts set enabled = true where organization_id = ${project} and account_id = ${`pricing-${max}`}`).rejects.toThrow('Organization active account limit');
    });
  }

  it('keeps extra editors read-only after a paid downgrade while preserving organization roles', async () => {
    for (const user of [1, 2, 3, 4]) await save(user, 'viewer');
    await db()`update public.organization_subscriptions set plan = 'premium', status = 'active' where organization_id = ${company}`;
    for (const user of [1, 2, 3]) await save(user, 'member');
    const access = (user: number) => applyPlanToPrincipal({ organizationId: project, userId: users[user]!, scopes: ['tools:read', 'tools:write'] });
    expect((await access(3)).scopes).toContain('tools:write');
    await db()`update public.organization_subscriptions set plan = 'operator' where organization_id = ${company}`;
    expect((await access(0)).scopes).toContain('tools:write');
    expect((await access(1)).scopes).toContain('tools:write');
    expect((await access(3)).scopes).toEqual(['tools:read']);
    expect((await resolveMembership(users[3]!, project)).role).toBe('member');
  });
});
