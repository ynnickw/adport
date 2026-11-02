import catalog from './plan-catalog.json';

export type PlanLimitKind = 'active_accounts' | 'members' | 'retention' | 'write_access';
export type UpgradePlanId = 'operator' | 'premium' | 'agency' | 'enterprise';

export interface PlanLimitDetails {
  kind: PlanLimitKind;
  currentPlan: string;
  recommendedPlan: UpgradePlanId;
  message: string;
  upgradeUrl?: string;
  canManageBilling?: boolean;
  projectId?: string;
}

export interface PlanRequirements { activeAccounts?: number; members?: number; retentionDays?: number; writeAccess?: boolean; }

export function recommendUpgradePlan(current: keyof typeof catalog, required?: PlanRequirements): UpgradePlanId {
  const order = ['reader', 'operator', 'premium', 'agency', 'enterprise'] as const;
  const candidates = order.slice(order.indexOf(current) + 1) as UpgradePlanId[];
  return candidates.find(id => {
    const plan = catalog[id];
    return (!required?.activeAccounts || plan.maxActiveAccounts === null || plan.maxActiveAccounts >= required.activeAccounts)
      && (!required?.members || plan.maxMembers === null || plan.maxMembers >= required.members)
      && (!required?.retentionDays || plan.maxRetentionDays >= required.retentionDays)
      && (!required?.writeAccess || plan.writeAccess);
  }) ?? 'enterprise';
}

export function billingUpgradePath(limit: Pick<PlanLimitDetails, 'kind' | 'recommendedPlan' | 'projectId'>): string {
  return '/dashboard/billing?' + new URLSearchParams({ intent: limit.kind, plan: limit.recommendedPlan, ...(limit.projectId ? { projectId: limit.projectId } : {}) });
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
  const limit = response.planLimit;
  return response.code === 'PLAN_LIMIT' && limit && typeof limit.message === 'string'
    && ['active_accounts', 'members', 'retention', 'write_access'].includes(limit.kind)
    && ['operator', 'premium', 'agency', 'enterprise'].includes(limit.recommendedPlan)
    ? limit : undefined;
}
