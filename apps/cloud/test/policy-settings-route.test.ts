import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '@adport/core';
import { createPolicySettingsDraft, policySettingsInput } from '@/lib/policy-settings';

const mocks = vi.hoisted(() => ({ session: vi.fn(), query: vi.fn(), json: vi.fn() }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@/lib/cloud/plans', () => ({ getOrganizationEntitlement: async () => ({ plan: { name: 'Growth', maxRetentionDays: 90 } }) }));
vi.mock('@/lib/db', () => ({ db: () => Object.assign(mocks.query, { json: mocks.json, begin: async (run: (sql: unknown) => Promise<void>) => run(mocks.query) }) }));
import { PATCH } from '@/app/api/settings/route';

const organizationId = '11111111-1111-4111-8111-111111111111';
const request = (body: unknown) => new Request('https://app.adport.test/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ organizationId, userId: 'owner', role: 'owner', scopes: [] });
  mocks.query.mockResolvedValue([]);
  mocks.json.mockImplementation(value => value);
});

describe('policy settings save boundary', () => {
  it('accepts limits turned off by the form and persists null while keeping validation required', async () => {
    const draft = createPolicySettingsDraft(DEFAULT_POLICY, 30, []);
    draft.budgetChangeEnabled = false;
    const input = policySettingsInput(draft);
    const response = await PATCH(request({ organizationId, ...input }));
    expect(response.status).toBe(200);
    expect(mocks.session).toHaveBeenCalledWith(organizationId);
    expect(mocks.json).toHaveBeenCalledWith(expect.objectContaining({ require_validation: true, max_budget_delta_pct: null, max_daily_budget_micros: null }));
    expect(await response.json()).toMatchObject({ updated: true, policy: input.policy });
  });

  it('rejects an attempt to turn off the preview gate before saving', async () => {
    expect((await PATCH(request({ organizationId, policy: { ...DEFAULT_POLICY, require_validation: false }, dataRetentionDays: 30 }))).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(['member', 'viewer'])('keeps policy edits restricted for %s', async role => {
    mocks.session.mockResolvedValue({ organizationId, userId: 'user', role, scopes: [] });
    expect((await PATCH(request({ organizationId, policy: DEFAULT_POLICY, dataRetentionDays: 30 }))).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
