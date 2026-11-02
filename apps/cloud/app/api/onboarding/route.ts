import { captureProductEvent } from '@/lib/cloud/product-analytics';
import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { AGENT_IDS, LEGACY_AGENT_IDS, ONBOARDING_STEPS, updateOnboardingState } from '@/lib/cloud/onboarding';
import { apiError, noStoreJson } from '@/lib/http';
import { getAssistantConnectionStatus } from '@/lib/cloud/assistant-connection';

const inputSchema = z.object({
  currentStep: z.enum(ONBOARDING_STEPS),
  // A page loaded before this release may still send 'vscode'.
  selectedAgent: z.enum([...AGENT_IDS, 'vscode']).transform((id) => LEGACY_AGENT_IDS[id] ?? id).pipe(z.enum(AGENT_IDS)).optional(),
  complete: z.boolean().optional(),
  skip: z.boolean().optional(),
  setupKind: z.enum(['first_project', 'new_project']).optional(),
});

export async function GET(request: Request) {
  try {
    const agent = z.enum(AGENT_IDS).optional().parse(new URL(request.url).searchParams.get('agent') ?? undefined);
    return noStoreJson(await getAssistantConnectionStatus(await sessionPrincipal(), agent));
  }
  catch (error) { return apiError(error, 403); }
}

export async function POST(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    if (Boolean(input.complete) !== (input.currentStep === 'complete')) throw new Error('Completed onboarding must use the complete step and a verified connection.');
    if (input.skip && (input.complete || input.currentStep === 'complete')) throw new Error('Skipped setup must preserve its current step.');
    const principal = await sessionPrincipal();
    await updateOnboardingState(principal, input);
    captureProductEvent(principal, { event: 'onboarding_progressed', step: input.currentStep, complete: input.complete ?? false, skipped: input.skip ?? false, setup_kind: input.setupKind, agent: input.selectedAgent });
    return noStoreJson({ updated: true });
  } catch (error) {
    return apiError(error, error instanceof z.ZodError ? 400 : 403);
  }
}
