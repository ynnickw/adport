import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDbForTests, db } from '@/lib/db';
import { resolveMembership } from '@/lib/cloud/repository';

const mocks = vi.hoisted(() => ({ client: vi.fn(), setCookie: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client }));
vi.mock('next/navigation', () => ({ redirect: (path: string): never => { throw new Error(`redirect:${path}`); } }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: mocks.setCookie }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
import { selectProjectAction } from '@/app/dashboard/projects/actions';

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;
describeDatabase('real passwordless invitation sessions', () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const admin = createClient(url, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const users: string[] = [];
  let invited: SupabaseClient;
  let invitedId: string;
  let email: string;
  let projectId: string;
  let otherProjectId: string;

  function selection(id: string) { const form = new FormData(); form.set('projectId', id); return form; }

  beforeAll(async () => {
    const owner = await admin.auth.admin.createUser({ email: `invite-owner-${randomUUID()}@example.test`, email_confirm: true });
    if (owner.error || !owner.data.user) throw new Error('Could not create invitation test owner');
    users.push(owner.data.user.id);
    projectId = (await resolveMembership(owner.data.user.id)).organizationId;
    email = `invite-new-${randomUUID()}@example.test`;
    const invitation = await admin.auth.admin.generateLink({ type: 'invite', email });
    if (invitation.error || !invitation.data.user) throw new Error('Could not generate test invitation');
    invitedId = invitation.data.user.id;
    users.push(invitedId);
    otherProjectId = (await resolveMembership(invitedId)).organizationId;
    await db()`insert into public.organization_memberships (organization_id, user_id, role) values (${projectId}, ${invitedId}, 'viewer')`;
    invited = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const verified = await invited.auth.verifyOtp({ type: 'invite', token_hash: invitation.data.properties.hashed_token });
    if (verified.error || !verified.data.session) throw new Error('Could not verify test invitation');
    mocks.client.mockResolvedValue(invited);
  });

  afterAll(async () => {
    if (users.length) {
      await db()`delete from public.organizations where created_by in ${db()(users)} and id <> organization_group_id`;
      await db()`delete from public.organizations where created_by in ${db()(users)}`;
      for (const id of users) await admin.auth.admin.deleteUser(id);
    }
    await closeDbForTests();
  });

  it('joins with a verified invitation session without choosing a password or updating the account', async () => {
    const before = await admin.auth.admin.getUserById(invitedId);
    expect(before.error).toBeNull();
    const user = await invited.auth.getUser();
    expect(user.data.user?.id).toBe(invitedId);
    expect(Boolean(user.data.user?.email_confirmed_at)).toBe(true);
    await expect(selectProjectAction(selection(projectId))).rejects.toThrow('redirect:/dashboard');
    expect(mocks.setCookie).toHaveBeenCalledWith('adport_project', projectId, expect.objectContaining({ httpOnly: true }));
    expect((await resolveMembership(invitedId, projectId)).role).toBe('viewer');
    const after = await admin.auth.admin.getUserById(invitedId);
    expect(after.error).toBeNull();
    expect(after.data.user?.updated_at).toBe(before.data.user?.updated_at);
  });

  it('can sign in again with an email link without setting a password', async () => {
    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (link.error) throw new Error('Could not generate test sign-in link');
    const returning = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const verified = await returning.auth.verifyOtp({ type: 'magiclink', token_hash: link.data.properties.hashed_token });
    expect(verified.error).toBeNull();
    expect(verified.data.user?.id).toBe(invitedId);
    mocks.client.mockResolvedValueOnce(returning);
    await expect(selectProjectAction(selection(projectId))).rejects.toThrow('redirect:/dashboard');
  });

  it('rejects a different signed-in account even with the correct invitation project ID', async () => {
    mocks.setCookie.mockClear();
    // The owner has no membership in the invitee’s separate personal project.
    mocks.client.mockResolvedValueOnce({ auth: { getUser: async () => ({ data: { user: { id: users[0] } }, error: null }) } });
    await expect(selectProjectAction(selection(otherProjectId))).rejects.toThrow('access');
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });
});
