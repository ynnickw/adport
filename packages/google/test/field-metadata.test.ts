import { createContext, type ToolContext } from '@adport/core';
import { describe, expect, it } from 'vitest';
import { GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';

// GoogleAdsFieldService and GoogleAdsField protos v25 at googleapis@57aa4dbc.
async function fixture(response: unknown, authorizeToolCall?: ToolContext['authorizeToolCall']) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const provider = new GoogleAdsProvider(new GoogleAdsRestClient({ clientId: 'test-client', clientSecret: 'test-secret', refreshToken: 'test-refresh', loginCustomerId: '9999999999' }, 'v25', async (input, init = {}) => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }); return Response.json(response);
  }));
  const runtime = await createContext({ providerModules: [{ provider, tools: googleTools(provider) }], authorizeToolCall });
  return { calls, runtime, call: (input: Record<string, unknown>) => runtime.registry.call('google_field_metadata', { account_id: '1234567890', ...input }, runtime.ctx) };
}

describe('Google API field metadata', () => {
  it('uses the global native search path, no FROM or manager header, and preserves native flags, enums and int64 totals', async () => {
    const result = { name: 'campaign.status', resourceName: 'googleAdsFields/campaign.status', category: 'ATTRIBUTE', dataType: 'ENUM', selectable: true, filterable: true, sortable: false, enumValues: ['ENABLED', 'PAUSED', 'REMOVED'] };
    const f = await fixture({ results: [result], totalResultsCount: '9007199254740993' });
    expect(await f.call({ field_names: ['campaign.status'] })).toEqual({ api_version: 'v25', results: [result], total_results_count: '9007199254740993', truncated: false });
    expect(f.calls).toHaveLength(1); const request = f.calls[0]!;
    expect(request.url).toBe('https://googleads.googleapis.com/v25/googleAdsFields:search');
    expect(request.body).toEqual({ query: "SELECT name, category, data_type, type_url, is_repeated, selectable, filterable, sortable, enum_values WHERE name IN ('campaign.status')", pageSize: 1 });
    expect(request.headers.has('login-customer-id')).toBe(false); expect(request.headers.get('authorization')).toBe('Bearer test-token');
    expect(f.runtime.registry.get('google_field_metadata').annotations).toMatchObject({ readOnly: true, destructive: false });
  });

  it('requests compatibility explicitly, preserves native continuation on empty pages and sends exactly one page', async () => {
    const f = await fixture({ nextPageToken: 'next-native-page' });
    expect(await f.call({ field_names: ['campaign', 'metrics.cost_micros'], include_compatibility: true, page_token: 'previous-native-page' })).toEqual({ api_version: 'v25', results: [], truncated: true, next_page_token: 'next-native-page' });
    expect(f.calls[0]!.body).toMatchObject({ pageSize: 2, pageToken: 'previous-native-page' });
    expect(f.calls[0]!.body.query).toContain("enum_values, selectable_with, attribute_resources, metrics, segments WHERE name IN ('campaign', 'metrics.cost_micros')");
    expect(f.calls).toHaveLength(1);
  });

  it('preserves omitted native values and returns only matching metadata without fabricating missing fields', async () => {
    const result = { name: 'campaign', category: 'RESOURCE', selectableWith: ['campaign.id'], metrics: ['metrics.cost_micros'] };
    const f = await fixture({ results: [result] });
    expect(await f.call({ field_names: ['campaign', 'unknown_field'], include_compatibility: true })).toEqual({ api_version: 'v25', results: [result], truncated: false });
  });

  it.each([
    { results: [{ name: 'campaign.status', category: 'ATTRIBUTE', resourceName: 'googleAdsFields/other' }] },
    { results: [{ name: 'other.status', category: 'ATTRIBUTE' }] },
    { results: [{ name: 'campaign.status', category: 'ATTRIBUTE', selectable: 'true' }] },
    { results: [{ name: 'campaign.status', category: 'ATTRIBUTE' }, { name: 'campaign.status', category: 'ATTRIBUTE' }] },
    { results: 'invalid' },
  ])('rejects malformed or unrequested native metadata %j', async response => {
    const f = await fixture(response); await expect(f.call({ field_names: ['campaign.status'] })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('rejects injection, duplicates, excessive requests and invalid accounts before OAuth or API access', async () => {
    const f = await fixture({});
    for (const input of [{ field_names: ["campaign' OR 1=1"] }, { field_names: [] }, { field_names: ['campaign', 'campaign'] }, { field_names: Array.from({ length: 21 }, (_, i) => `field_${i}`) }, { field_names: ['campaign'], account_id: 'other' }]) await expect(f.call(input)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  it('keeps metadata behind the existing project authorization boundary', async () => {
    const f = await fixture({}, async () => { throw new Error('Account/project unavailable'); });
    await expect(f.call({ field_names: ['campaign'] })).rejects.toThrow('Account/project unavailable'); expect(f.calls).toEqual([]);
  });
});
