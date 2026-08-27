import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { getOrganizationEntitlement } from '@/lib/cloud/plans';
import { setOrganizationAdAccountEnabled } from '@/lib/cloud/repository';
import { isCloudProvider } from '@/lib/cloud/types';
import { apiError, noStoreJson } from '@/lib/http';

const inputSchema = z.object({
  organizationId: z.string().uuid(),
  provider: z.string(),
  accountId: z.string().min(1).max(255),
  enabled: z.boolean(),
});

export async function POST(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    if (!isCloudProvider(input.provider)) throw new Error('Unknown provider.');
    const principal = await sessionPrincipal(input.organizationId);
    const entitlement = await getOrganizationEntitlement(principal.organizationId);
    await setOrganizationAdAccountEnabled({
      principal,
      provider: input.provider,
      accountId: input.accountId,
      enabled: input.enabled,
      maxActiveAccounts: entitlement.plan.maxActiveAccounts,
    });
    return noStoreJson({ updated: true });
  } catch (error) {
    return apiError(error, 403);
  }
}
