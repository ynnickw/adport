export type PlanLimitKind = 'active_accounts' | 'members' | 'retention';
export type UpgradePlanId = 'operator' | 'agency' | 'enterprise';

export interface PlanLimitDetails {
  kind: PlanLimitKind;
  currentPlan: string;
  recommendedPlan: UpgradePlanId;
  message: string;
}

export interface PlanLimitResponse {
  error: string;
  code: 'PLAN_LIMIT';
  planLimit: PlanLimitDetails;
}

export class PlanLimitError extends Error {
  readonly code = 'PLAN_LIMIT';
  readonly status = 402;

  constructor(readonly details: Omit<PlanLimitDetails, 'message'> & { message: string }) {
    super(details.message);
    this.name = 'PlanLimitError';
  }
}

export function planLimitFromResponse(value: unknown): PlanLimitDetails | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const response = value as Partial<PlanLimitResponse>;
  return response.code === 'PLAN_LIMIT' && response.planLimit?.message ? response.planLimit : undefined;
}
