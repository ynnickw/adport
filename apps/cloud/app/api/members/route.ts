import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import {
  changeOrganizationMemberRole,
  inviteOrganizationMember,
  listOrganizationMembers,
  removeOrganizationMember,
} from '@/lib/cloud/tenant-admin';
import { apiError, noStoreJson } from '@/lib/http';

const roleSchema = z.enum(['admin', 'member', 'viewer']);
const inviteSchema = z.object({ organizationId: z.string().uuid(), email: z.string().email().max(320), role: roleSchema });
const updateSchema = z.object({ organizationId: z.string().uuid(), userId: z.string().uuid(), role: roleSchema });

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
    const input = inviteSchema.parse(await request.json());
    const principal = await sessionPrincipal(input.organizationId);
    const result = await inviteOrganizationMember(principal, input.email, input.role);
    return noStoreJson(result, result.added ? 201 : 200);
  } catch (error) {
    return apiError(error, 403);
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
    const organizationId = z.string().uuid().parse(url.searchParams.get('organization_id'));
    const userId = z.string().uuid().parse(url.searchParams.get('user_id'));
    const principal = await sessionPrincipal(organizationId);
    await removeOrganizationMember(principal, userId);
    return noStoreJson({ removed: true });
  } catch (error) {
    return apiError(error, 403);
  }
}
