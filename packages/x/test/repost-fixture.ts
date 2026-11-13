import { XAdsClient } from '../src/client.js';
import { XAdsProvider } from '../src/provider.js';
import type { NativePost } from '../src/post-schemas.js';
import type { WriteOperation } from '@adport/core';

export const REPOST_ACCOUNT = 'a1', REPOST_SOURCE = '2417045708', REPOST_RECEIVER = '756201191646691328', REPOST_ID = '1166476031668015104';
type Row = Record<string, any>;
export type RepostCall = { url: URL; init: RequestInit };
export function repostFixture(count = 2) {
  const campaign = { id: 'c1', name: 'QA campaign', currency: 'USD', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null };
  const line = { id: 'l1', name: 'QA ad group', campaign_id: 'c1', currency: 'USD', entity_status: 'PAUSED', deleted: false, placements: ['ALL_ON_TWITTER'], product_type: 'PROMOTED_TWEETS', objective: 'ENGAGEMENTS', daily_budget_amount_local_micro: 5_000_000, total_budget_amount_local_micro: null };
  const original: NativePost = { id_str: REPOST_ID, user: { id_str: REPOST_SOURCE }, name: 'Source post', full_text: '<Source> + Unicode ✓', nullcast: false, tweet_type: 'PUBLISHED', truncated: false, entities: { urls: [] } };
  const sources = Array.from({ length: count }, (_, i) => ({ ...original, id_str: String(BigInt(REPOST_ID) + BigInt(i)), name: `Source ${i + 1}`, full_text: original.full_text + ` ${i + 1}` })), copies: NativePost[] = [], associations: Row[] = [], calls: RepostCall[] = [];
  const users: Row[] = [{ id: 'u1', user_id: REPOST_SOURCE, promotable_user_type: 'RETWEETS_ONLY', deleted: false }, { id: 'u2', user_id: REPOST_RECEIVER, promotable_user_type: 'FULL', deleted: false }];
  const state = { users, sources, copies, associations, campaign, line, nativeDelay: 0, postInFlight: 0, peakPostInFlight: 0, hook: undefined as undefined | ((call: RepostCall) => unknown | Promise<unknown>) };
  const client = new XAdsClient({ consumerKey: 'inert', consumerSecret: 'inert', accessToken: 'inert', accessTokenSecret: 'inert' }, async (raw, init = {}) => {
    const call = { url: new URL(String(raw)), init };calls.push(call);const path = call.url.pathname.replace('/12/accounts/a1', ''), q = call.url.searchParams, write = path === '/promoted_tweets' && init.method === 'POST';
    if (write) { state.postInFlight++;state.peakPostInFlight = Math.max(state.peakPostInFlight, state.postInFlight); }
    try {
      const custom = await state.hook?.(call);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
      if (init.method === 'GET') {
        if (!path) return Response.json({ data: { id: REPOST_ACCOUNT, name: 'QA', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false } });
        if (path === '/promotable_users') return Response.json({ data: state.users, next_cursor: null });
        if (path === '/campaigns/c1') return Response.json({ data: state.campaign });
        if (path === '/line_items/l1') return Response.json({ data: state.line });
        if (path === '/tweets') { const ids = q.get('tweet_ids')?.split(',');return Response.json({ data: [...state.sources, ...state.copies].filter(row => row.user.id_str === q.get('user_id') && (!ids || ids.includes(row.id_str))), next_cursor: null }); }
        if (path === '/promoted_tweets') { const rows = state.associations.filter(row => q.get('with_deleted') === 'true' || !row.deleted), offset = Number(q.get('cursor') ?? 0), count = Number(q.get('count') ?? 200);return Response.json({ data: rows.slice(offset, offset + count), next_cursor: offset + count < rows.length ? String(offset + count) : null }); }
        if (path.startsWith('/promoted_tweets/')) { const row = state.associations.find(row => row.id === path.split('/').at(-1));return row ? Response.json({ data: row }) : new Response('', { status: 404 }); }
      }
      if (write) {
        if (state.nativeDelay) await new Promise(resolve => setTimeout(resolve, state.nativeDelay));
        const source = state.sources.find(row => row.id_str === q.get('tweet_ids'));if (!source) throw new Error('Synthetic copy request must identify one exact source');
        const index = state.associations.length, copy = { ...source, id_str: String(BigInt(REPOST_ID) + 10000n + BigInt(index)), user: { id_str: REPOST_RECEIVER }, name: null, nullcast: true, full_text: 'RT @source: ' + source.full_text }, row = { id: 'pt' + index, line_item_id: 'l1', tweet_id: copy.id_str, entity_status: 'ACTIVE', deleted: false };state.copies.push(copy);state.associations.push(row);return Response.json({ data: [row] });
      }
      if (path.startsWith('/promoted_tweets/') && init.method === 'DELETE') { const row = state.associations.find(row => row.id === path.split('/').at(-1));if (!row) return new Response('', { status: 404 });row.deleted = true;return Response.json({ data: row }); }
      throw new Error(`Unexpected synthetic ${init.method} ${path}`);
    } finally { if (write) state.postInFlight--; }
  });
  const provider = new XAdsProvider(client), selection = () => ({ line_item_id: 'l1', user_id: REPOST_SOURCE, tweet_ids: state.sources.map(row => row.id_str) }), context = () => provider.posts.repostContext(REPOST_ACCOUNT, selection());
  const input = async () => ({ ...selection(), expected_context_hash: (await context()).context_hash, acknowledge_active_associations: true, acknowledge_new_published_copies: true });
  const operation = async (): Promise<WriteOperation> => ({ provider: 'x', accountId: REPOST_ACCOUNT, tool: 'x_create_repost_promotions', kind: 'create', payload: await input() });
  return { provider, state, calls, context, input, operation, selection, mutations: () => calls.filter(call => call.init.method !== 'GET') };
}
