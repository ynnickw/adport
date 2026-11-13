import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import type { z } from 'zod';
import type { nativePromotedAccount } from '../src/promoted-account-schemas.js';

export const A = 'a1', L = 'l1', U = '771791717175468032', U2 = '771791717175468033', P = 'pa1';
export const account = { id: A, name: 'Synthetic account', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false };
export const campaign = { id: 'c1', name: 'Synthetic campaign', currency: 'USD', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null };
export const line = { id: L, name: 'Synthetic follower group', campaign_id: 'c1', currency: 'USD', entity_status: 'PAUSED', deleted: false, placements: ['ALL_ON_TWITTER'], product_type: 'PROMOTED_ACCOUNT', objective: 'FOLLOWERS', daily_budget_amount_local_micro: 5_000_000, total_budget_amount_local_micro: null };
export const user = { id: 'pu1', user_id: U, promotable_user_type: 'FULL', deleted: false };
export const association: z.infer<typeof nativePromotedAccount> = { id: P, line_item_id: L, user_id: U, entity_status: 'ACTIVE', deleted: false, approval_status: 'ACCEPTED' };
export type Call = { url: URL; init: RequestInit };
export type Options = { account?: Record<string, unknown>; line?: Record<string, unknown>; campaign?: Record<string, unknown>; users?: Array<Record<string, unknown>>; associations?: typeof association[]; handler?(call: Call): unknown | Promise<unknown> };
export function promotedAccountFixture(options: Options = {}) {
  const calls: Call[] = [], selectedAccount = { ...account, ...options.account }, parent = { ...line, ...options.line }, funding = { ...campaign, ...options.campaign }, users = structuredClone(options.users ?? [user]), associations = structuredClone(options.associations ?? []);
  const client = new XAdsClient({ consumerKey: 'key', consumerSecret: 'secret', accessToken: 'access', accessTokenSecret: 'access-secret' }, async (raw, init = {}) => {
    const call = { url: new URL(String(raw)), init };calls.push(call);const custom = await options.handler?.(call);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    const path = call.url.pathname.replace(`/12/accounts/${A}`, ''), q = call.url.searchParams, ok = (data: unknown) => Response.json({ data });
    if (init.method === 'GET') {
      if (!path) return ok(selectedAccount);
      if (path === '/line_items/' + L) return ok(parent);
      if (path === '/campaigns/c1') return ok(funding);
      if (path === '/promotable_users') return Response.json({ data: users, next_cursor: null });
      if (path === '/promoted_accounts') {
        const rows = associations.filter(row => row.line_item_id === q.get('line_item_ids') && (q.get('with_deleted') === 'true' || !row.deleted)), start = Number(q.get('cursor') ?? 0), count = Number(q.get('count'));
        return Response.json({ data: rows.slice(start, start + count), next_cursor: start + count < rows.length ? String(start + count) : null });
      }
      if (path.startsWith('/promoted_accounts/')) { const row = associations.find(value => value.id === path.split('/').at(-1));return row ? ok(row) : new Response('', { status: 404 }); }
    }
    if (path === '/promoted_accounts' && init.method === 'POST') { const row = { ...association, id: 'pa' + (associations.length + 1), user_id: q.get('user_id')!, line_item_id: q.get('line_item_id')! };associations.push(row);return ok(row); }
    if (path.startsWith('/promoted_accounts/') && init.method === 'DELETE') { const row = associations.find(value => value.id === path.split('/').at(-1))!;row.deleted = true;return ok(row); }
    throw new Error(`Unexpected synthetic endpoint ${init.method} ${path}`);
  });
  return { provider: new XAdsProvider(client), calls, selectedAccount, parent, funding, users, associations };
}
export const mutations = (f: ReturnType<typeof promotedAccountFixture>) => f.calls.filter(call => call.init.method !== 'GET');
