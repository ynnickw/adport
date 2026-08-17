import { z } from 'zod';
import { policySchema } from '@adport/core';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { updateOrganizationSettings } from '@/lib/cloud/tenant-admin';
import { apiError, noStoreJson } from '@/lib/http';

const inputSchema = z.object({
  organizationId: z.string().uuid(),
  policy: policySchema,
  dataRetentionDays: z.number().int().min(1).max(3650),
});

export async function PATCH(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    const principal = await sessionPrincipal(input.organizationId);
    await updateOrganizationSettings(principal, input.policy, input.dataRetentionDays);
    return noStoreJson({ updated: true, policy: input.policy, dataRetentionDays: input.dataRetentionDays });
  } catch (error) {
    return apiError(error, 403);
  }
}
