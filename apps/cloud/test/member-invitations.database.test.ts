import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDbForTests, db } from '@/lib/db';
import { acceptMemberInvitation, cancelMemberInvitation, listPendingInvitations, previewMemberInvitation, sendMemberInvitation } from '@/lib/cloud/member-invitations';
import { resolveMembership } from '@/lib/cloud/repository';
import { saveOrganizationMember } from '@/lib/cloud/workspaces';

const send = vi.hoisted(() => vi.fn(async (_email: string, _token: string, userId: string | null) => userId!));
vi.mock('@/lib/cloud/invitation-email', () => ({ sendMemberInvitationEmail: send }));

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;
describeDatabase('member invitation acceptance', () => {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
  const users: Array<{ userId: string; email: string }> = [];
  let targetId: string;
  const target = () => ({ scope: 'organization' as const, targetId });
  const request = () => ({ ...target(), actorUserId: users[0]!.userId });
  const token = () => send.mock.calls.at(-1)![1];

  beforeAll(async () => {
    for (let index = 0; index < 5; index++) {
      const email = `membership-invite-${randomUUID()}@example.test`;
      const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
      if (error || !data.user) throw error ?? new Error('Failed to create test account.');
      users.push({ userId: data.user.id, email });
    }
    targetId = (await resolveMembership(users[0]!.userId)).organizationId;
    await db()`update public.organization_subscriptions set plan = 'agency', status = 'active' where organization_id = ${targetId}`;
  });

  afterAll(async () => {
    if (users.length) {
      await db()`delete from public.organizations where created_by in ${db()(users.map(user => user.userId))}`;
      for (const user of users) await admin.auth.admin.deleteUser(user.userId);
    }
    await closeDbForTests();
  });

  it('emails an existing account and grants ownership only to the accepting recipient', async () => {
    const recipient = users[1]!;
    await sendMemberInvitation({ ...request(), email: recipient.email, role: 'owner' });
    expect(send).toHaveBeenLastCalledWith(recipient.email, expect.any(String), recipient.userId);
    const link = token();
    await expect(resolveMembership(recipient.userId, targetId)).rejects.toThrow('access');
    expect(await listPendingInvitations(users[0]!.userId, target())).toMatchObject([{ email: recipient.email, role: 'owner' }]);
    expect(await previewMemberInvitation(link, recipient)).toMatchObject({ role: 'owner' });
    expect(await previewMemberInvitation(link, users[2]!)).toBeUndefined();
    await expect(acceptMemberInvitation(link, { ...recipient, email: users[2]!.email })).rejects.toThrow('unavailable');
    await expect(acceptMemberInvitation(link, users[2]!)).rejects.toThrow('unavailable');
    const outcomes = await Promise.allSettled([acceptMemberInvitation(link, recipient), acceptMemberInvitation(link, recipient)]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: targetId }]);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await resolveMembership(recipient.userId, targetId)).role).toBe('owner');
    expect(await listPendingInvitations(users[0]!.userId, target())).toEqual([]);
    await expect(acceptMemberInvitation(link, recipient)).rejects.toThrow('unavailable');
  });

  it('keeps the current role until an ownership promotion is accepted', async () => {
    const recipient = users[2]!;
    await saveOrganizationMember({ actorUserId: users[0]!.userId, organizationId: targetId,
      userId: recipient.userId, role: 'member', projectIds: [targetId] });
    await expect(saveOrganizationMember({ actorUserId: users[0]!.userId, organizationId: targetId,
      userId: recipient.userId, role: 'owner', projectIds: [], existingOnly: true })).rejects.toThrow('must accept');
    await sendMemberInvitation({ ...request(), promoteUserId: recipient.userId, role: 'owner' });
    expect((await resolveMembership(recipient.userId, targetId)).role).toBe('member');
    expect(await listPendingInvitations(users[0]!.userId, target())).toMatchObject([{ previousRole: 'member' }]);
    await acceptMemberInvitation(token(), recipient);
    expect((await resolveMembership(recipient.userId, targetId)).role).toBe('owner');
  });

  it('rejects canceled invitations and invitations sent by a demoted owner', async () => {
    const recipient = users[3]!;
    await sendMemberInvitation({ ...request(), email: recipient.email, role: 'admin' });
    const canceledToken = token();
    const [pending] = await listPendingInvitations(users[0]!.userId, target());
    await cancelMemberInvitation(users[0]!.userId, pending!.id);
    await expect(acceptMemberInvitation(canceledToken, recipient)).rejects.toThrow('unavailable');

    await sendMemberInvitation({ ...target(), actorUserId: users[1]!.userId, email: recipient.email, role: 'owner' });
    await saveOrganizationMember({ actorUserId: users[0]!.userId, organizationId: targetId, userId: users[1]!.userId, role: 'admin', projectIds: [] });
    await expect(acceptMemberInvitation(token(), recipient)).rejects.toThrow('Only an organization owner');
    await expect(resolveMembership(recipient.userId, targetId)).rejects.toThrow('access');
    const [outstanding] = await listPendingInvitations(users[0]!.userId, target());
    await cancelMemberInvitation(users[0]!.userId, outstanding!.id);
  });

  it('releases a failed delivery for retry without granting access', async () => {
    const recipient = users[4]!;
    const invitation = { ...request(), email: recipient.email, role: 'viewer' as const, projectIds: [targetId] };
    send.mockRejectedValueOnce(new Error('mail unavailable'));
    await expect(sendMemberInvitation(invitation)).rejects.toThrow('email could not be sent');
    expect(await listPendingInvitations(users[0]!.userId, target())).toEqual([]);
    await expect(resolveMembership(recipient.userId, targetId)).rejects.toThrow('access');
    await sendMemberInvitation(invitation);
    await expect(acceptMemberInvitation(token(), recipient)).resolves.toBe(targetId);
    expect((await resolveMembership(recipient.userId, targetId)).role).toBe('viewer');
  });
});
