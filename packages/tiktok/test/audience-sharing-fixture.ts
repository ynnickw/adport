import { customAudienceFixture, CUSTOM_ACCOUNT, CUSTOM_AUDIENCE } from './custom-audience-fixture.js';

export const SHARING_RECIPIENT = '7678335757387513874', SHARING_RECIPIENT2 = '7678335757387513875', SHARING_BC = '6001';
type Row = Record<string, any>;
type Call = { url: URL; init: RequestInit; body?: Row; form?: FormData };
export function audienceSharingFixture() {
  const f = customAudienceFixture(), state = { authorized: [CUSTOM_ACCOUNT, SHARING_RECIPIENT, SHARING_RECIPIENT2], assets: [{ asset_id: CUSTOM_ACCOUNT, asset_type: 'ADVERTISER', asset_name: 'Source account', advertiser_role: 'ADMIN' }, { asset_id: SHARING_RECIPIENT, asset_type: 'ADVERTISER', asset_name: 'Recipient account', advertiser_role: 'OPERATOR' }, { asset_id: SHARING_RECIPIENT2, asset_type: 'ADVERTISER', asset_name: 'Second recipient', advertiser_role: 'OPERATOR' }] as Row[], shares: [] as Row[], changed: false, hook: undefined as undefined | ((call: Call) => Response | undefined) }, ok = (data: unknown) => Response.json({ code: 0, message: 'OK', data });
  f.state.hook = call => {
    const override = state.hook?.(call);if (override) return override;const path = call.url.pathname, q = call.url.searchParams;
    if (path.endsWith('/oauth2/advertiser/get/')) return ok({ list: state.authorized.map(advertiser_id => ({ advertiser_id })) });
    if (path.endsWith('/bc/asset/get/')) { const page = Number(q.get('page')), size = Number(q.get('page_size'));return ok({ list: state.assets.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_number: state.assets.length, total_page: Math.ceil(state.assets.length / size) } }); }
    if (path.endsWith('/custom_audience/share/log/')) return ok({ list: state.shares.filter(row => row.custom_audience_id === q.get('custom_audience_id')) });
    if (path.endsWith('/custom_audience/share/')) { state.changed = true;for (const custom_audience_id of call.body!.custom_audience_ids) for (const shared_advertiser_id of call.body!.shared_advertiser_ids) state.shares.push({ custom_audience_id, shared_advertiser_id, shared_advertiser_name: state.assets.find(row => row.asset_id === shared_advertiser_id)?.asset_name ?? 'Native recipient', status: 'PROCESSING' });f.state.rows.forEach(row => { row.shared = true; });return ok({}); }
    if (path.endsWith('/custom_audience/share/cancel/')) { state.changed = true;state.shares = state.shares.filter(row => !(row.custom_audience_id === call.body!.custom_audience_id && row.shared_advertiser_id === call.body!.shared_advertiser_id));f.state.rows.forEach(row => { row.shared = false; });return ok({}); }
    return undefined;
  };
  const selection = { account_id: CUSTOM_ACCOUNT, bc_id: SHARING_BC, custom_audience_ids: [CUSTOM_AUDIENCE], shared_advertiser_ids: [SHARING_RECIPIENT] };
  const shareInput = async (extra: Row = {}) => { const input = { ...selection, ...extra };return { ...input, expected_context_hash: (await f.provider.audienceSharing.context(input)).context_hash, acknowledge_recipient_access: true }; };
  const unshareInput = async () => ({ account_id: CUSTOM_ACCOUNT, bc_id: SHARING_BC, custom_audience_id: CUSTOM_AUDIENCE, shared_advertiser_id: SHARING_RECIPIENT, expected_context_hash: (await f.provider.audienceSharing.context({ ...selection, action: 'UNSHARE' })).context_hash, acknowledge_shared_effects: true });
  return { ...f, sharing: state, selection, readInput: { account_id: CUSTOM_ACCOUNT, custom_audience_ids: [CUSTOM_AUDIENCE], shared_advertiser_ids: [SHARING_RECIPIENT] }, shareInput, unshareInput, ok, nativeShare: (recipient = SHARING_RECIPIENT) => ({ custom_audience_id: CUSTOM_AUDIENCE, shared_advertiser_id: recipient, shared_advertiser_name: 'Native recipient', status: 'PROCESSING' }) };
}
