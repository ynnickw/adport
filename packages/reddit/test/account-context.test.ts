import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, toolInSelection, type ToolContext } from '@adport/core';
import { RedditAdsClient } from '../src/client.js';
import { RedditAdsProvider } from '../src/provider.js';
import { redditTools } from '../src/tools.js';

const accountId = 'a2_qa';
const businessId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
// Official GET ad_accounts/{id}, data.business_id and optional fields, refreshed
// from https://ads-api.reddit.com/api/v3/openapi.json on2026-11-07.
function fixture(data: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);calls.push({ url, init });
    if (url === 'https://www.reddit.com/api/v1/access_token') return Response.json({ access_token: 'qa-token', expires_in: 3600 });
    if (url === `https://ads-api.reddit.com/api/v3/ad_accounts/${accountId}` && init.method === 'GET') return Response.json({ data });
    throw new Error('Unexpected native request');
  }) as unknown as typeof fetch;
  const provider = new RedditAdsProvider(new RedditAdsClient({ clientId: 'qa-client', clientSecret: 'qa-secret', refreshToken: 'qa-refresh', userAgent: 'desktop:dev.adport.qa:v1' }, fetchImpl));
  const registry = new ToolRegistry();registry.register(redditTools(provider));
  const read = (args: unknown = { account_id: accountId }, ctx = {} as ToolContext) => registry.call('reddit_account_context', args, ctx);
  return { calls, provider, registry, read };
}

describe('Reddit account context', () => {
  it('reads only the selected account and returns allowlisted metadata without inferring catalog authority', async () => {
    const f = fixture({ id: accountId, business_id: businessId.toUpperCase(), name: 'QA account', currency: 'EUR', admin_approval: 'VALID', primary_contact_member_id: 'PRIVATE-MEMBER', spend_cap: 123, pixel_partner_preferences: ['PRIVATE-TRACKING'], future_private_field: 'PRIVATE-UNKNOWN' });
    const result = await f.read();
    expect(result).toEqual({ id: accountId, business_id: businessId, name: 'QA account', currency: 'EUR', admin_approval: 'VALID', catalog_access: 'EXPLICIT_PROJECT_GRANT_REQUIRED' });
    expect(f.registry.get('reddit_account_context').output!.safeParse(result).success).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]).toMatchObject({ url: `https://ads-api.reddit.com/api/v3/ad_accounts/${accountId}`, init: { method: 'GET', headers: { authorization: 'Bearer qa-token', accept: 'application/json' } } });
    expect(f.calls[1]!.init.body).toBeUndefined();
    const access = await f.provider.catalogs.access(accountId);
    expect(access).toMatchObject({ grants: [], records: [] });
    expect(f.calls).toHaveLength(2);
  });

  it('leaves unavailable optional fields absent without guessing a Business or status', async () => {
    const f = fixture({ id: accountId });
    expect(await f.read()).toEqual({ id: accountId, catalog_access: 'EXPLICIT_PROJECT_GRANT_REQUIRED' });
  });

  it.each([
    { id: 'a2_foreign', business_id: businessId },
    { business_id: businessId },
    { id: accountId, business_id: 'invalid-business' },
    { id: accountId, currency: 'bad' },
    [{ id: accountId, business_id: businessId }],
  ])('rejects mismatched or malformed account metadata %#', async data => {
    const f = fixture(data);
    await expect(f.read()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(f.calls).toHaveLength(2);
  });

  it('rejects path and grant injection before requesting the provider', async () => {
    const f = fixture({ id: accountId });
    await expect(f.read({ account_id: '../me/businesses' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.read({ account_id: accountId, business_id: businessId, mode: 'create' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.calls).toHaveLength(0);
  });

  it('runs project/account authorization before the native read', async () => {
    const f = fixture({ id: accountId });
    const authorizeToolCall = vi.fn(() => { throw new Error('Account is not enabled in this project'); });
    await expect(f.read(undefined, { authorizeToolCall } as unknown as ToolContext)).rejects.toThrow('not enabled');
    expect(authorizeToolCall).toHaveBeenCalledWith(f.registry.get('reddit_account_context'), { account_id: accountId });
    expect(f.calls).toHaveLength(0);
  });

  it('is a standard read tool while generic API access remains excluded', () => {
    const f = fixture({ id: accountId }), tool = f.registry.get('reddit_account_context');
    expect(tool.annotations).toMatchObject({ readOnly: true, destructive: false });
    for (const profile of ['standard', 'reporting', 'full'] as const) expect(toolInSelection(tool, { profile, providers: ['reddit'] })).toBe(true);
    expect(toolInSelection(tool, { profile: 'full', providers: ['google'] })).toBe(false);
    expect(toolInSelection(f.registry.get('reddit_api_read'), { profile: 'full', providers: ['reddit'] })).toBe(false);
  });
});
