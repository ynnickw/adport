import { describe, expect, it } from 'vitest';
import { PlanLimitError, planLimitFromResponse } from '../lib/cloud/plan-limit';
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
