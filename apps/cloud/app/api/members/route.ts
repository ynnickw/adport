import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import {
  changeOrganizationMemberRole,
  listOrganizationMembers,
  removeOrganizationMember,
} from '@/lib/cloud/tenant-admin';
import { apiError, HttpError, noStoreJson } from '@/lib/http';
import { sendMemberInvitation } from '@/lib/cloud/member-invitations';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { env } from '@/lib/env';

const roleSchema = z.enum(['admin', 'member', 'viewer']);
const inviteSchema = z.object({ organizationId: z.string().uuid(), email: z.string().trim().email().max(320), role: roleSchema });
const updateSchema = z.object({ organizationId: z.string().uuid(), userId: z.string().uuid(), role: roleSchema });
const removeSchema = updateSchema.omit({ role: true });

export async function GET(request: Request) {
  try {
    const organizationId = z.string().uuid().parse(new URL(request.url).searchParams.get('organization_id'));
    const principal = await sessionPrincipal(organizationId);
    return noStoreJson({ members: await listOrganizationMembers(principal.organizationId) });
  } catch (error) {
    return apiError(error, 403);
  }
}

export async function POST(request: Request) {
  try {
    if (request.headers.get('origin') !== new URL(env().ADPORT_CLOUD_BASE_URL).origin) throw new HttpError('Invalid request origin.', 403);
    const input = inviteSchema.parse(await request.json());
    const principal = await sessionPrincipal(input.organizationId);
    if (!principal.userId) throw new HttpError('Sign in to send an invitation.', 401);
    if (!await enforceRateLimit(`workspace:${principal.userId}`, 30)) throw new HttpError('Too many changes. Try again in a minute.', 429);
    await sendMemberInvitation({ actorUserId: principal.userId, scope: 'project', targetId: principal.organizationId, email: input.email, role: input.role });
    return noStoreJson({ invitationSent: true, status: 'pending' }, 201);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return apiError(new HttpError('Enter an email address and choose a project role.', 400));
    if (error instanceof Error && error.message === 'You do not have access to this organization.') return apiError(error, 403);
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const input = updateSchema.parse(await request.json());
    const principal = await sessionPrincipal(input.organizationId);
    await changeOrganizationMemberRole(principal, input.userId, input.role);
    return noStoreJson({ updated: true });
  } catch (error) {
    return apiError(error, 403);
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const input = removeSchema.parse(url.searchParams.has('organization_id') || url.searchParams.has('user_id')
      ? { organizationId: url.searchParams.get('organization_id'), userId: url.searchParams.get('user_id') }
      : await request.json());
    const principal = await sessionPrincipal(input.organizationId);
    await removeOrganizationMember(principal, input.userId);
    return noStoreJson({ removed: true });
  } catch (error) {
    return apiError(error, 403);
  }
}
