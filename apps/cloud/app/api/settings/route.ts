import { z } from 'zod';
import { policySchema } from '@adport/core';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { renameOrganization, updateOrganizationSettings } from '@/lib/cloud/tenant-admin';
import { apiError, noStoreJson } from '@/lib/http';

const inputSchema = z
  .object({
    organizationId: z.string().uuid(),
    organizationName: z.string().trim().min(1).max(120).optional(),
    policy: policySchema.optional(),
    dataRetentionDays: z.number().int().min(1).max(3650).optional(),
  })
  .refine(
    (input) => input.organizationName !== undefined || (input.policy !== undefined && input.dataRetentionDays !== undefined),
    { message: 'Provide organizationName, or policy with dataRetentionDays.' },
  );

export async function PATCH(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    const principal = await sessionPrincipal(input.organizationId);
    if (input.organizationName !== undefined) await renameOrganization(principal, input.organizationName);
    if (input.policy !== undefined && input.dataRetentionDays !== undefined) {
      await updateOrganizationSettings(principal, input.policy, input.dataRetentionDays);
    }
    return noStoreJson({
      updated: true,
      ...(input.organizationName !== undefined ? { organizationName: input.organizationName.trim() } : {}),
      ...(input.policy !== undefined ? { policy: input.policy, dataRetentionDays: input.dataRetentionDays } : {}),
    });
  } catch (error) {
    return apiError(error, 403);
  }
}
