import { describe, expect, it } from 'vitest';
import { PlanLimitError, planLimitFromResponse, recommendUpgradePlan, billingUpgradePath } from '../lib/cloud/plan-limit';
import { apiError } from '../lib/http';

describe('plan limit responses', () => {
  it('returns a structured payment-required response for the upgrade modal', async () => {
    const response = apiError(new PlanLimitError({
      kind: 'active_accounts',
      currentPlan: 'Reader',
      recommendedPlan: 'operator',
      message: 'This plan supports 3 active ad accounts. Disable another account first.',
    }), 403);

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body).toMatchObject({
      code: 'PLAN_LIMIT',
      planLimit: {
        kind: 'active_accounts',
        currentPlan: 'Reader',
        recommendedPlan: 'operator',
      },
    });
    expect(planLimitFromResponse(body)?.message).toMatch(/3 active ad accounts/);
  });

  it('does not treat ordinary API failures as plan limits', () => {
    expect(planLimitFromResponse({ error: 'Forbidden' })).toBeUndefined();
  });
});

describe('upgrade recommendations', () => {
  it('fits the whole requested account batch instead of recommending an insufficient next tier', () => {
    expect(recommendUpgradePlan('reader', { activeAccounts: 4 })).toBe('operator');
    expect(recommendUpgradePlan('reader', { activeAccounts: 12 })).toBe('premium');
    expect(recommendUpgradePlan('operator', { activeAccounts: 35 })).toBe('agency');
    expect(recommendUpgradePlan('premium', { activeAccounts: 65 })).toBe('enterprise');
  });
  it('fits seats, retention, and write access while keeping the current tier as a floor', () => {
    expect(recommendUpgradePlan('reader', { members: 7 })).toBe('agency');
    expect(recommendUpgradePlan('operator', { retentionDays: 730 })).toBe('agency');
    expect(recommendUpgradePlan('reader', { writeAccess: true })).toBe('operator');
    expect(recommendUpgradePlan('premium', { members: 2 })).toBe('agency');
  });
  it('keeps organization context in shareable upgrade links', () => {
    expect(billingUpgradePath({ kind: 'members', recommendedPlan: 'premium', projectId: 'project-id' }))
      .toBe('/dashboard/billing?intent=members&plan=premium&projectId=project-id');
  });
  it('rejects malformed plan-limit payloads', () => {
    expect(planLimitFromResponse({ code: 'PLAN_LIMIT', planLimit: { kind: 'other', recommendedPlan: 'operator', message: 'Limit' } })).toBeUndefined();
    expect(planLimitFromResponse({ code: 'PLAN_LIMIT', planLimit: { kind: 'members', recommendedPlan: 'external', message: 'Limit' } })).toBeUndefined();
  });
});
