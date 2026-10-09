import { describe, expect, it, vi } from 'vitest';
import { MetaGraphClient } from '../src/client.js';
import { MetaAdsProvider } from '../src/provider.js';
import { metaTools } from '../src/tools.js';

const campaign = { id: '123', account_id: '456', name: 'Review campaign', status: 'PAUSED', daily_budget: '1000' };

function fixture(body: unknown) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
  const provider = new MetaAdsProvider(new MetaGraphClient({ accessToken: 'test' }, 'v26.0', fetch));
  return { provider, fetch };
}

describe('explicit Meta campaign reads', () => {
  it('gets only the fixed campaign fields and verifies account ownership', async () => {
    const { provider, fetch } = fixture(campaign);
    expect(await provider.getCampaign({ account_id: 'act_456', campaign_id: '123' })).toEqual(campaign);
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toMatch(/\/123$/);
    expect(url.searchParams.get('fields')).toBe('id,account_id,name,status,effective_status,objective,daily_budget,lifetime_budget');
  });

  it('rejects a campaign belonging to another account', async () => {
    const { provider } = fixture(campaign);
    await expect(provider.getCampaign({ account_id: '789', campaign_id: '123' })).rejects.toThrow(/does not belong/);
  });

  it('lists only the campaigns edge with bounded pagination', async () => {
    const { provider, fetch } = fixture({ data: [campaign] });
    expect(await provider.listCampaigns({ account_id: '456', limit: 10 })).toEqual({ campaigns: [campaign], count: 1 });
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toMatch(/\/act_456\/campaigns$/);
    const tool = metaTools(provider).find(tool => tool.name === 'meta_list_campaigns')!;
    expect(tool.input.safeParse({ account_id: '456', limit: 5001 }).success).toBe(false);
  });
});
