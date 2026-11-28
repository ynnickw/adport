'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { WorkspaceActionState } from '@/app/dashboard/projects/actions';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { saveSetupWorkspaceNames } from '@/lib/cloud/workspaces';
import { HttpError } from '@/lib/http';
import { safeDashboardReturnPath } from '@/lib/return-path';

const name = z.string().trim().min(1).max(120);
const names = z.object({ projectId: z.uuid(), organizationName: name, projectName: name });

export async function saveWorkspaceNamesAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  const tenant = await requireDashboardTenant();
  const input = names.safeParse(Object.fromEntries(form));
  if (!input.success) return { error: 'Enter both names using up to 120 characters each.' };
  if (tenant.organizationId !== input.data.projectId) return { error: 'Switch back to this project before saving its setup.' };
  const advance = form.get('advance') === '1';
  try {
    if (!await enforceRateLimit(`workspace:${tenant.userId}`, 30)) throw new HttpError('Too many changes. Try again in a minute.', 429);
    await saveSetupWorkspaceNames(tenant.userId, input.data.projectId, { ...input.data, advance });
  } catch (error) {
    if (error instanceof HttpError) return { error: error.message };
    console.error('Workspace setup names could not be saved.');
    return { error: 'Workspace names could not be saved. Try again.' };
  }
  revalidatePath('/dashboard', 'layout');
  revalidatePath('/onboarding');
  if (advance) {
    const params = new URLSearchParams({ return_to: safeDashboardReturnPath(form.get('return_to')), step: 'connect' });
    redirect('/onboarding?' + params);
  }
  return { success: 'Workspace names saved.' };
}
