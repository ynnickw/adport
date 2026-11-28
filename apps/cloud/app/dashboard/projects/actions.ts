'use server';

import { captureProductEvent } from '@/lib/cloud/product-analytics';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { PROJECT_COOKIE } from '@/lib/cloud/auth';
import { resolveMembership, enforceRateLimit } from '@/lib/cloud/repository';
import { createOrganization, createProject, updateProject, renameCompany, saveOrganizationMember, removeCompanyMember } from '@/lib/cloud/workspaces';
import { HttpError } from '@/lib/http';
import { PlanLimitError, type PlanLimitDetails } from '@/lib/cloud/plan-limit';
import { safeProjectSwitchReturnPath } from '@/lib/return-path';
import { cancelMemberInvitation, sendMemberInvitation } from '@/lib/cloud/member-invitations';
import { transferProject } from '@/lib/cloud/project-transfers';

export interface WorkspaceActionState { error?: string; success?: string; planLimit?: PlanLimitDetails; }
const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(120);

async function userId(): Promise<string> {
  const { data, error } = await (await createClient()).auth.getUser();
  if (error || !data.user) throw new HttpError('Sign in to continue.', 401);
  return data.user.id;
}

async function setProject(id: string): Promise<void> {
  (await cookies()).set(PROJECT_COOKIE, id, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 90,
  });
}

async function mutation(work: (actor: string) => Promise<void | string>): Promise<WorkspaceActionState> {
  let success: void | string;
  try {
    const actor = await userId();
    if (!await enforceRateLimit(`workspace:${actor}`, 30)) throw new HttpError('Too many changes. Please try again in a minute.', 429);
    success = await work(actor);
  } catch (error) {
    if (error instanceof z.ZodError) return { error: 'Check the name, email, role, and selected projects.' };
    if (error instanceof PlanLimitError) return { error: error.message, planLimit: error.details };
    if (error instanceof HttpError) return { error: error.message };
    const message = error instanceof Error ? error.message : '';
    if (/^(Organization (active account|member) limit reached|The default project cannot be archived)/.test(message)) return { error: message };
    console.error('Workspace management failed', { name: error instanceof Error ? error.name : 'UnknownError' });
    return { error: 'The change could not be saved. Please try again.' };
  }
  revalidatePath('/dashboard', 'layout');
  return { success: success || 'Changes saved.' };
}

export async function selectProjectAction(form: FormData): Promise<void> {
  const id = uuid.parse(form.get('projectId'));
  await resolveMembership(await userId(), id);
  await setProject(id);
  redirect(safeProjectSwitchReturnPath(form.get('return_to')));
}

export async function createOrganizationAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  const result = await mutation(async actor => {
    const projectId = await createOrganization(actor, name.parse(form.get('name')));
    await setProject(projectId);
    captureProductEvent({ userId: actor, organizationId: projectId }, { event: 'organization_created' });
  });
  if (!result.error) redirect('/onboarding');
  return result;
}

export async function createProjectAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  const result = await mutation(async actor => {
    const projectId = await createProject(actor, uuid.parse(form.get('organizationId')), name.parse(form.get('name')));
    await setProject(projectId);
    captureProductEvent({ userId: actor, organizationId: projectId }, { event: 'project_created' });
  });
  if (!result.error) redirect('/onboarding');
  return result;
}

export async function updateProjectAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  return mutation(actor => updateProject(actor, uuid.parse(form.get('projectId')), {
    name: form.has('name') ? name.parse(form.get('name')) : undefined,
    archived: form.has('archived') ? z.enum(['true', 'false']).parse(form.get('archived')) === 'true' : undefined,
  }));
}

export async function transferProjectAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  const input = z.object({ projectId: uuid, sourceOrganizationId: uuid, destinationOrganizationId: uuid }).safeParse({
    projectId: form.get('projectId'),
    sourceOrganizationId: form.get('sourceOrganizationId'),
    destinationOrganizationId: form.get('destinationOrganizationId'),
  });
  if (!input.success) return { error: 'Choose a destination organization.' };
  const result = await mutation(async actor => {
    const transfer = await transferProject({ actorUserId: actor, ...input.data });
    await setProject(transfer.archived ? transfer.destinationProjectId : input.data.projectId);
  });
  if (result.error) return result;
  redirect(`/dashboard/projects?transferred=${input.data.projectId}`);
}

export async function renameCompanyAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  return mutation(actor => renameCompany(actor, uuid.parse(form.get('organizationId')), name.parse(form.get('name'))));
}

export async function saveMemberAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  return mutation(async actor => {
    const targetId = uuid.parse(form.get('organizationId'));
    const role = z.enum(['owner', 'admin', 'member', 'viewer']).parse(form.get('role'));
    const projectIds = z.array(uuid).max(500).parse(form.getAll('projectIds'));
    const targetUserId = form.get('userId') ? uuid.parse(form.get('userId')) : undefined;
    const invitation = { actorUserId: actor, scope: 'organization' as const, targetId };
    if (!targetUserId) {
      await sendMemberInvitation({ ...invitation, email: z.string().trim().email().max(320).parse(form.get('email')), role, projectIds });
      return 'Invitation sent. Access starts after they accept.';
    }
    if (role === 'owner') {
      const sent = await sendMemberInvitation({ ...invitation, promoteUserId: targetUserId, role });
      return sent ? 'Ownership invitation sent. Their role changes after they accept.' : 'This member is already an owner.';
    }
    await saveOrganizationMember({ actorUserId: actor, organizationId: targetId, userId: targetUserId, role, projectIds, existingOnly: true });
    return 'Access saved.';
  });
}

export async function cancelMemberInvitationAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  return mutation(async actor => {
    await cancelMemberInvitation(actor, uuid.parse(form.get('invitationId')));
    return 'Invitation canceled.';
  });
}

export async function removeMemberAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  return mutation(actor => removeCompanyMember(actor, uuid.parse(form.get('organizationId')), uuid.parse(form.get('userId'))));
}
