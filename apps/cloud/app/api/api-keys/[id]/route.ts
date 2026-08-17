import { sessionPrincipal } from '@/lib/cloud/auth';
import { revokeApiKey } from '@/lib/cloud/repository';
import { apiError, noStoreJson } from '@/lib/http';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const organizationId = new URL(request.url).searchParams.get('organization_id') ?? undefined;
    const principal = await sessionPrincipal(organizationId);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    const { id } = await params;
    const revoked = await revokeApiKey(principal, id);
    return noStoreJson({ revoked });
  } catch (error) {
    return apiError(error, 403);
  }
}
