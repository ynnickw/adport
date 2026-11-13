import { describe, expect, it } from 'vitest';
import type { WriteOperation } from '@adport/core';
import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// MicrosoftDocs/Advertising@fdee2fcf; native campaign empty envelope live-verified2026-11-03.
type Row = Record<string, unknown>;
type Call = { path: string; body: Row; init: RequestInit };
const account = '777', guard = { forcePausedCreation: true }, campaign = { type: 'Campaign', campaign_id: '9' } as const, group = { type: 'AdGroup', campaign_id: '9', ad_group_id: '10' } as const;
const keyword = (Id = '100', Text = 'existing excluded phrase', MatchType = 'Phrase'): Row => ({ Id, Text, MatchType });
function fixture(override?: (path: string, body: Row, method: string, calls: Call[]) => unknown) {
  const calls: Call[] = [], state = { keywords: { '9': [] as Row[], '10': [] as Row[] }, campaignStatus: 'Active' };
  const client = new MicrosoftAdsClient({ developerToken: 'dev', clientId: 'client', refreshToken: 'refresh' }, undefined, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token', expires_in: 3600 });
    const path = url.pathname.replace(/^.*\/v13\//, ''), body = JSON.parse(String(init.body ?? '{}')) as Row, method = init.method ?? 'POST'; calls.push({ path, body, init });
    const custom = override?.(path, body, method, calls); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (path === 'Accounts/Search') return Response.json({ Accounts: [{ Id: account, ParentCustomerId: '9001' }] });
    if (path === 'Campaigns/QueryByAccountId') return Response.json({ Campaigns: [{ Id: '9', Name: 'Owned campaign', Status: state.campaignStatus }] });
    if (path === 'AdGroups/QueryByIds') return Response.json({ AdGroups: (body.AdGroupIds as string[]).includes('10') ? [{ Id: '10', Status: 'Active' }] : [] });
    if (path === 'NegativeKeywords/QueryByEntityIds') return Response.json({ PartialErrors: null, EntityNegativeKeywords: [{ EntityId: (body.EntityIds as string[])[0], EntityType: body.EntityType, NegativeKeywords: state.keywords[(body.EntityIds as Array<keyof typeof state.keywords>)[0]!] }] });
    if (path === 'EntityNegativeKeywords') {
      const entity = (body.EntityNegativeKeywords as Row[])[0]!, key = entity.EntityId as keyof typeof state.keywords, values = entity.NegativeKeywords as Row[];
      if (method === 'POST') {
        const added = values.map((value, index) => ({ ...value, Id: String(100 + state.keywords[key].length + index) })); state.keywords[key].push(...added);
        return Response.json({ NegativeKeywordIds: [{ Ids: added.map(value => value.Id) }], NestedPartialErrors: [null] });
      }
      if (method === 'DELETE') { state.keywords[key] = state.keywords[key].filter(value => !values.some(item => item.Id === value.Id)); return Response.json({ NestedPartialErrors: [] }); }
    }
    throw new Error(`Unexpected path ${path}`);
  });
  return { provider: new MicrosoftAdsProvider(client), state, calls };
}
const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'create'): WriteOperation => ({ tool, provider: 'microsoft', accountId: account, kind, payload });
const add = { target: campaign, keywords: [{ text: 'qa excluded query', match_type: 'Exact' }, { text: 'qa excluded phrase', match_type: 'Phrase' }] };

describe('Microsoft direct negative keywords', () => {
  it('defines tools lazily and permits only native Exact/Phrase exclusions', () => {
    const tools = microsoftTools(new Proxy({} as MicrosoftAdsProvider, { get() { throw new Error('Eager access'); } })), schema = tools.find(value => value.name === 'microsoft_add_negative_keywords')!.input;
    expect(schema.safeParse({ account_id: account, ...add }).success).toBe(true);
    expect(schema.safeParse({ account_id: account, target: campaign, keywords: [{ text: 'qa', match_type: 'Broad' }] }).success).toBe(false);
    expect(schema.safeParse({ account_id: account, target: campaign, keywords: [{ text: ' ', match_type: 'Exact' }] }).success).toBe(false);
    expect(schema.safeParse({ account_id: account, target: campaign, keywords: [add.keywords[0], add.keywords[0]] }).success).toBe(false);
  });

  it('uses account headers and the native ignored null parent for campaign queries', async () => {
    const f = fixture(); expect(await f.provider.negativeKeywords.list({ account_id: account, target: campaign, limit: 10 })).toEqual({ rows: [], truncated: false });
    expect(f.calls.at(-1)!.body).toEqual({ EntityIds: ['9'], EntityType: 'Campaign', ParentEntityId: null });
    expect(f.calls.at(-1)!.init.headers).toMatchObject({ CustomerAccountId: account, CustomerId: '9001', DeveloperToken: 'dev' });
  });

  it('verifies ad-group ownership and uses its campaign as ParentEntityId', async () => {
    const f = fixture(); await f.provider.negativeKeywords.list({ account_id: account, target: group, limit: 10 });
    expect(f.calls.find(value => value.path === 'AdGroups/QueryByIds')!.body).toEqual({ CampaignId: '9', AdGroupIds: ['10'] });
    expect(f.calls.at(-1)!.body).toEqual({ EntityIds: ['10'], EntityType: 'AdGroup', ParentEntityId: '9' });
    const before = f.calls.filter(value => value.path === 'NegativeKeywords/QueryByEntityIds').length;
    await expect(f.provider.negativeKeywords.list({ account_id: account, target: { ...group, ad_group_id: '99' }, limit: 10 })).rejects.toThrow('not found');
    expect(f.calls.filter(value => value.path === 'NegativeKeywords/QueryByEntityIds')).toHaveLength(before);
  });

  it('paginates decimal IDs without Number rounding and preserves direct native configuration', async () => {
    const f = fixture(); f.state.keywords['9'] = [keyword('9007199254740993'), keyword('11'), keyword('9')];
    const first = await f.provider.negativeKeywords.list({ account_id: account, target: campaign, limit: 1 });
    expect(first).toMatchObject({ rows: [{ Id: '9' }], truncated: true, next_cursor: '9' });
    expect(await f.provider.negativeKeywords.list({ account_id: account, target: campaign, limit: 2, after_keyword_id: '9' })).toEqual({ rows: [keyword('11'), keyword('9007199254740993')], truncated: false });
  });

  it('appends exclusions only on apply and does not invent a Paused status on an active parent', async () => {
    const f = fixture(), operation = op('microsoft_add_negative_keywords', add);
    expect(await f.provider.previewWrite(operation, guard)).toMatchObject({ serverValidated: false, coercions: [], budgetDeltas: [] });
    expect(f.calls.some(value => value.path === 'EntityNegativeKeywords')).toBe(false);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: ['100', '101'] });
    expect(f.calls.find(value => value.path === 'EntityNegativeKeywords')!.body).toEqual({ EntityNegativeKeywords: [{ EntityId: '9', EntityType: 'Campaign', NegativeKeywords: [{ Text: 'qa excluded query', MatchType: 'Exact' }, { Text: 'qa excluded phrase', MatchType: 'Phrase' }] }] });
    expect(f.calls.some(value => value.path === 'Campaigns' || value.path === 'AdGroups')).toBe(false);
  });

  it('rejects existing entries and the native 20000-entry capacity before mutation', async () => {
    const f = fixture(); f.state.keywords['9'] = [keyword('100', 'qa excluded query', 'Exact')];
    await expect(f.provider.previewWrite(op('microsoft_add_negative_keywords', add), guard)).rejects.toThrow('already exists');
    f.state.keywords['9'] = Array.from({ length: 20000 }, (_, index) => keyword(String(index + 1), `existing${index}`, 'Exact'));
    await expect(f.provider.previewWrite(op('microsoft_add_negative_keywords', add), guard)).rejects.toThrow('20000');
    expect(f.calls.some(value => value.path === 'EntityNegativeKeywords')).toBe(false);
  });

  it('retains successful IDs from nested partial failures without retrying the native write', async () => {
    const f = fixture(path => path === 'EntityNegativeKeywords' ? { NegativeKeywordIds: [{ Ids: ['100', null] }], NestedPartialErrors: [{ Index: 0, BatchErrors: [{ Index: 1, Code: 123, Message: 'Native rejection' }] }] } : undefined);
    await expect(f.provider.applyWrite(op('microsoft_add_negative_keywords', add), guard)).rejects.toMatchObject({ details: { resourceIds: ['100'] } });
    expect(f.calls.filter(value => value.path === 'EntityNegativeKeywords')).toHaveLength(1);
  });

  it('reports accepted IDs when content readback is unavailable', async () => {
    const f = fixture((path, body, _method, calls) => path === 'NegativeKeywords/QueryByEntityIds' && calls.some(value => value.path === 'EntityNegativeKeywords') ? { EntityNegativeKeywords: [{ EntityId: (body.EntityIds as string[])[0], EntityType: body.EntityType, NegativeKeywords: [] }] } : undefined);
    await expect(f.provider.applyWrite(op('microsoft_add_negative_keywords', add), guard)).rejects.toMatchObject({ details: { resourceIds: ['100', '101'] } });
    expect(f.calls.filter(value => value.path === 'EntityNegativeKeywords')).toHaveLength(1);
  });

  it('removes only explicitly owned IDs and leaves other direct exclusions intact', async () => {
    const f = fixture(); f.state.keywords['10'] = [keyword(), keyword('101', 'keep this exclusion')];
    await expect(f.provider.previewWrite(op('microsoft_remove_negative_keywords', { target: group, keyword_ids: ['999'] }, 'remove'), guard)).rejects.toThrow('not found');
    expect(await f.provider.applyWrite(op('microsoft_remove_negative_keywords', { target: group, keyword_ids: ['100'] }, 'remove'), guard)).toEqual({ applied: true, resourceIds: ['100'] });
    expect(f.calls.find(value => value.init.method === 'DELETE')!.body).toEqual({ EntityNegativeKeywords: [{ EntityId: '10', EntityType: 'AdGroup', NegativeKeywords: [{ Id: '100' }] }] });
    expect(f.state.keywords['10']).toEqual([keyword('101', 'keep this exclusion')]);
  });

  it('fails closed for foreign envelopes and unsafe native IDs', async () => {
    for (const envelope of [{ EntityId: '99', EntityType: 'Campaign', NegativeKeywords: [] }, { EntityId: '9', EntityType: 'Campaign', NegativeKeywords: [keyword('9007199254740993'), { ...keyword(), Id: 9007199254740992 }] }]) {
      const f = fixture(path => path === 'NegativeKeywords/QueryByEntityIds' ? { EntityNegativeKeywords: [envelope] } : undefined);
      await expect(f.provider.previewWrite(op('microsoft_add_negative_keywords', add), guard)).rejects.toThrow();
      expect(f.calls.some(value => value.path === 'EntityNegativeKeywords')).toBe(false);
    }
  });
});
