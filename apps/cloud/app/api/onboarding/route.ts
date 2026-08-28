import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { AGENT_IDS, ONBOARDING_STEPS, updateOnboardingState } from '@/lib/cloud/onboarding';
import { apiError, noStoreJson } from '@/lib/http';

const inputSchema = z.object({
  currentStep: z.enum(ONBOARDING_STEPS),
  selectedAgent: z.enum(AGENT_IDS).optional(),
  complete: z.boolean().optional(),
});

export async function POST(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    if (input.complete && input.currentStep !== 'complete') throw new Error('Completed onboarding must use the complete step.');
    const principal = await sessionPrincipal();
    await updateOnboardingState(principal, input);
    return noStoreJson({ updated: true });
  } catch (error) {
    return apiError(error, error instanceof z.ZodError ? 400 : 403);
  }
}
