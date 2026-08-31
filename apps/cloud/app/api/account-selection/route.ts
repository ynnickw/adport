import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { saveAccountSelection } from '@/lib/cloud/account-selection';
import { apiError, noStoreJson } from '@/lib/http';

const schema = z.object({
  organizationId: z.string().uuid(),
  selectionId: z.string().uuid(),
  accountIds: z.array(z.string().min(1).max(255)).max(10000),
}).strict();

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const principal = await sessionPrincipal(input.organizationId);
    return noStoreJson(await saveAccountSelection(principal, input.selectionId, input.accountIds));
  } catch (error) {
    return apiError(error, 403);
  }
}
