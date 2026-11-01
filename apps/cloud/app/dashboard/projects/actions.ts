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

export interface WorkspaceActionState { error?: string; success?: string; }
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

async function mutation(work: (actor: string) => Promise<void>): Promise<WorkspaceActionState> {
  try {
    const actor = await userId();
    if (!await enforceRateLimit(`workspace:${actor}`, 30)) throw new HttpError('Too many changes. Please try again in a minute.', 429);
    await work(actor);
  } catch (error) {
    if (error instanceof z.ZodError) return { error: 'Check the name, email, role, and selected projects.' };
    if (error instanceof HttpError) return { error: error.message };
    const message = error instanceof Error ? error.message : '';
    if (/^(Organization (active account|member) limit reached|The default project cannot be archived)/.test(message)) return { error: message };
    console.error('Workspace management failed', { name: error instanceof Error ? error.name : 'UnknownError' });
    return { error: 'The change could not be saved. Please try again.' };
  }
  revalidatePath('/dashboard', 'layout');
  return { success: 'Changes saved.' };
}

export async function selectProjectAction(form: FormData): Promise<void> {
  const id = uuid.parse(form.get('projectId'));
  await resolveMembership(await userId(), id);
  await setProject(id);
  redirect('/dashboard');
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

export async function renameCompanyAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  return mutation(actor => renameCompany(actor, uuid.parse(form.get('organizationId')), name.parse(form.get('name'))));
}

export async function saveMemberAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  return mutation(actor => saveOrganizationMember({
    actorUserId: actor,
    organizationId: uuid.parse(form.get('organizationId')),
    userId: form.get('userId') ? uuid.parse(form.get('userId')) : undefined,
    email: form.get('email') ? z.string().email().max(320).parse(form.get('email')) : undefined,
    role: z.enum(['owner', 'admin', 'member', 'viewer']).parse(form.get('role')),
    projectIds: z.array(uuid).max(500).parse(form.getAll('projectIds')),
  }));
}

export async function removeMemberAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  return mutation(actor => removeCompanyMember(actor, uuid.parse(form.get('organizationId')), uuid.parse(form.get('userId'))));
}
