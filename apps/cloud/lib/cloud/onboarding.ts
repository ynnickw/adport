import 'server-only';
import { db } from '@/lib/db';
import type { TenantPrincipal } from './types';

export const ONBOARDING_STEPS = ['welcome', 'connect', 'accounts', 'agent', 'complete'] as const;
export const AGENT_IDS = ['chatgpt', 'codex', 'claude-code', 'claude', 'cursor', 'mcp'] as const;
/** Earlier releases offered VS Code; that choice now reads as the generic MCP client setup. */
export const LEGACY_AGENT_IDS: Record<string, OnboardingAgent> = { vscode: 'mcp' };
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
  const state = rows[0] ?? { currentStep: 'welcome', selectedAgent: null, completedAt: null };
  return { ...state, selectedAgent: state.selectedAgent ? LEGACY_AGENT_IDS[state.selectedAgent] ?? state.selectedAgent : null };
}

function requireOnboardingAdmin(principal: TenantPrincipal): void {
  if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
}

export async function updateOnboardingState(
  principal: TenantPrincipal,
  input: { currentStep: OnboardingStep; selectedAgent?: OnboardingAgent; complete?: boolean },
): Promise<void> {
  requireOnboardingAdmin(principal);
  try {
    await saveOnboardingState(principal.organizationId, input);
  } catch (error) {
    // Until migration 20261002090000 is applied, the column check rejects 'mcp'. The agent is only a
    // preference that preselects a setup tab, so save the step without it rather than block onboarding.
    if ((error as { code?: string }).code !== '23514' || !input.selectedAgent) throw error;
    await saveOnboardingState(principal.organizationId, { ...input, selectedAgent: undefined });
  }
}

async function saveOnboardingState(
  organizationId: string,
  input: { currentStep: OnboardingStep; selectedAgent?: OnboardingAgent; complete?: boolean },
): Promise<void> {
  await db()`
    insert into public.organization_onboarding (organization_id, current_step, selected_agent, completed_at)
    values (${organizationId}, ${input.currentStep}, ${input.selectedAgent ?? null}, ${input.complete ? new Date() : null})
    on conflict (organization_id) do update set
      current_step = excluded.current_step,
      selected_agent = coalesce(excluded.selected_agent, organization_onboarding.selected_agent),
      completed_at = case when ${input.complete ?? false} then now() else organization_onboarding.completed_at end
  `;
}
