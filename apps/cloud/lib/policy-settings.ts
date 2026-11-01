import type { Policy } from '@adport/core';

export interface PolicySettingsDraft {
  pausedCreation: boolean;
  budgetChangeEnabled: boolean;
  budgetChange: string;
  dailyBudgetEnabled: boolean;
  dailyBudget: string;
  previewLifetime: string;
  retentionDays: string;
  protectedAccounts: string[];
  otherAccountIds: string;
}

export function createPolicySettingsDraft(policy: Policy, retentionDays: number, accountIds: string[]): PolicySettingsDraft {
  const discovered = new Set(accountIds);
  return {
    pausedCreation: policy.paused_creation,
    budgetChangeEnabled: policy.max_budget_delta_pct !== null,
    budgetChange: String(policy.max_budget_delta_pct ?? 25),
    dailyBudgetEnabled: policy.max_daily_budget_micros !== null,
    dailyBudget: policy.max_daily_budget_micros === null ? '' : String(policy.max_daily_budget_micros / 1_000_000),
    previewLifetime: String(policy.pending_ttl_minutes),
    retentionDays: String(retentionDays),
    protectedAccounts: policy.protected_accounts.filter(id => discovered.has(id)),
    otherAccountIds: policy.protected_accounts.filter(id => !discovered.has(id)).join(', '),
  };
}

export function policySettingsInput(draft: PolicySettingsDraft): { policy: Policy; dataRetentionDays: number } {
  return {
    policy: {
      require_validation: true,
      paused_creation: draft.pausedCreation,
      max_budget_delta_pct: draft.budgetChangeEnabled ? Number(draft.budgetChange) : null,
      max_daily_budget_micros: draft.dailyBudgetEnabled ? Math.round(Number(draft.dailyBudget) * 1_000_000) : null,
      pending_ttl_minutes: Number(draft.previewLifetime),
      protected_accounts: [...new Set([
        ...draft.protectedAccounts,
        ...draft.otherAccountIds.split(',').map(id => id.trim()).filter(Boolean),
      ])].sort(),
    },
    dataRetentionDays: Number(draft.retentionDays),
  };
}
