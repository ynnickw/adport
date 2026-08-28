import 'server-only';
import { db } from '@/lib/db';
import type { TenantPrincipal } from './types';

export const ONBOARDING_STEPS = ['welcome', 'connect', 'accounts', 'agent', 'complete'] as const;
export const AGENT_IDS = ['chatgpt', 'codex', 'claude-code', 'claude', 'cursor', 'vscode'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingAgent = (typeof AGENT_IDS)[number];

export interface OnboardingState {
  currentStep: OnboardingStep;
  selectedAgent: OnboardingAgent | null;
  completedAt: Date | null;
}

export async function getOnboardingState(organizationId: string): Promise<OnboardingState> {
  const rows = await db()<OnboardingState[]>`
    select current_step, selected_agent, completed_at
    from public.organization_onboarding
    where organization_id = ${organizationId}
    limit 1
  `;
  return rows[0] ?? { currentStep: 'welcome', selectedAgent: null, completedAt: null };
}

function requireOnboardingAdmin(principal: TenantPrincipal): void {
  if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
}

export async function updateOnboardingState(
  principal: TenantPrincipal,
  input: { currentStep: OnboardingStep; selectedAgent?: OnboardingAgent; complete?: boolean },
): Promise<void> {
  requireOnboardingAdmin(principal);
  await db()`
    insert into public.organization_onboarding (organization_id, current_step, selected_agent, completed_at)
    values (${principal.organizationId}, ${input.currentStep}, ${input.selectedAgent ?? null}, ${input.complete ? new Date() : null})
    on conflict (organization_id) do update set
      current_step = excluded.current_step,
      selected_agent = coalesce(excluded.selected_agent, organization_onboarding.selected_agent),
      completed_at = case when ${input.complete ?? false} then now() else organization_onboarding.completed_at end
  `;
}
