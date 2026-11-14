import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import { audienceNativeId } from './custom-audience-schemas.js';
import { TikTokCustomAudiences, customAudienceConfiguration } from './custom-audiences.js';
import { audienceSharesRead, audienceSharingContext, shareAudiences, unshareAudience } from './audience-sharing-schemas.js';
import { nativeListComplete } from './pagination.js';

type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<WriteResult> };
type Audience = Awaited<ReturnType<TikTokCustomAudiences['inspect']>>[number];
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const nativeShare = z.object({ custom_audience_id: audienceNativeId, shared_advertiser_id: audienceNativeId, shared_advertiser_name: z.string().max(4096), status: z.string().max(128) });
type Share = z.infer<typeof nativeShare>;
const asset = z.object({ asset_id: audienceNativeId, asset_type: z.literal('ADVERTISER'), asset_name: z.string().max(4096), advertiser_role: z.string().max(128) });
const pageInfo = z.object({ page: z.number().int().positive().safe(), page_size: z.number().int().min(1).max(50), total_page: z.number().int().nonnegative().safe().optional(), total_number: z.number().int().nonnegative().safe().optional() });
const supported = new Set(['Customer File Audience', 'Engagement Audience', 'App Activity Audience', 'Website Audience', 'Lookalike Audience']);
const notices = ['This changes audience access for the selected destination advertisers. Revocation can affect ads already targeting a shared audience. No ad, budget or delivery status is changed.', 'Business Center membership and source role are checked from the authorized user’s native asset view. Native eligibility, account ownership requirements, quotas and concurrent operations remain authoritative.', 'Sharing-log presence and native audience status are separate from matching, targetability or delivery. No conditional-write, atomic batch or automatic replay is available.'];
const invalid = () => new AdportError('PROVIDER_ERROR', 'TikTok sharing scope, native representation or inventory completeness could not be verified.');
const preserved = (row: Audience) => { const { shared: _shared, ...configuration } = customAudienceConfiguration(row);return configuration; };

/** Official SDK f809c396 and current published share/cancel/log/BC-asset docs, checked2026-11-06. */
export class TikTokAudienceSharing {
  constructor(private readonly client: TikTokClient, private readonly audiences: TikTokCustomAudiences, private readonly authorizeAccounts: (ids: string[]) => Promise<void>) {}
  private async get(path: string, input: Record<string, unknown>) {
    try { return await this.client.get<unknown>(path, input); } catch (error) { const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};throw new AdportError('PROVIDER_ERROR', 'TikTok audience sharing read failed. Check existing native permissions; no access was changed.', { ...(Number.isSafeInteger(details.code) ? { native_code: details.code } : {}) }); }
  }
  private owned(account: string, row: Audience, share: boolean) {
    if (row.is_creator !== true || row.owner_id !== account) throw new AdportError('POLICY_VIOLATION', 'Audience sharing requires explicit selected-advertiser ownership; recipient access is insufficient.');
    if (share && (!supported.has(row.type.trim()) || row.is_valid !== true || row.is_expiring !== false || row.native_error_reported)) throw new AdportError('INVALID_INPUT', 'Only a documented shareable, available, non-expiring audience without a native error can be shared.');
  }
  private async log(account: string, audience: string): Promise<Share[]> {
    const parsed = z.object({ list: z.array(nativeShare).max(5000) }).safeParse(await this.get('dmp/custom_audience/share/log', { advertiser_id: account, custom_audience_id: audience }));
    if (!parsed.success || parsed.data.list.some(row => row.custom_audience_id !== audience) || new Set(parsed.data.list.map(row => row.shared_advertiser_id)).size !== parsed.data.list.length) throw invalid();
    return parsed.data.list.sort((a, b) => a.shared_advertiser_id.localeCompare(b.shared_advertiser_id));
  }
  private async logs(account: string, ids: string[]) { const rows = new Map<string, Share[]>();for (const id of ids) rows.set(id, await this.log(account, id));return rows; }
  private selection(account: string, targets: string[]) { if (targets.includes(account)) throw new AdportError('INVALID_INPUT', 'Choose destination advertisers other than the source.'); }
  private view(logs: Map<string, Share[]>, targets: string[]) { return [...logs.values()].flat().filter(row => targets.includes(row.shared_advertiser_id)); }
  async read(value: unknown) {
    const input = audienceSharesRead.parse(value);this.selection(input.account_id, input.shared_advertiser_ids);await this.authorizeAccounts([input.account_id, ...input.shared_advertiser_ids]);
    const audiences = await this.audiences.inspect(input.account_id, input.custom_audience_ids);audiences.forEach(row => this.owned(input.account_id, row, false));const logs = await this.logs(input.account_id, input.custom_audience_ids), selected = this.view(logs, input.shared_advertiser_ids);
    return { records: selected, shares: selected, audiences: audiences.map(row => ({ id: row.audience_id, name: row.name, snapshot_hash: row.snapshot_hash })), other_recipient_count: [...logs.values()].flat().length - selected.length, complete: true, truncated: false, notes: notices };
  }
  private async businessAccounts(bc: string, source: string, targets: string[]) {
    const wanted = new Set([source, ...targets]), found = new Map<string, z.infer<typeof asset>>(), seen = new Set<string>();let complete = false;
    for (let page = 1; page <= 100; page++) {
      const parsed = z.object({ list: z.array(asset).max(50), page_info: pageInfo.optional() }).safeParse(await this.get('bc/asset/get', { bc_id: bc, asset_type: 'ADVERTISER', page, page_size: 50 }));
      if (!parsed.success || parsed.data.page_info && (parsed.data.page_info.page !== page || parsed.data.page_info.page_size !== 50)) throw invalid();
      const info = parsed.data.page_info;
      if (info && (info.total_page !== undefined && info.total_page < page && parsed.data.list.length > 0 || info.total_number !== undefined && (parsed.data.list.length !== Math.max(0, Math.min(50, info.total_number - (page - 1) * 50)) || info.total_page !== undefined && (info.total_number === 0 ? info.total_page > 1 : info.total_page !== Math.ceil(info.total_number / 50))))) throw invalid();
      for (const row of parsed.data.list) { if (seen.has(row.asset_id)) throw invalid();seen.add(row.asset_id);if (wanted.has(row.asset_id)) found.set(row.asset_id, row); }
      if (found.size === wanted.size) break;
      const end = nativeListComplete(parsed.data.page_info, parsed.data.list.length);if (end !== false) { complete = end === true;break; }
    }
    if (found.size !== wanted.size) throw new AdportError('INVALID_INPUT', complete ? 'Selected source/destination accounts are not all accessible in this Business Center.' : 'Business Center membership is unconfirmed; inventory is incomplete.');
    if (!['ADMIN', 'OPERATOR'].includes(found.get(source)!.advertiser_role)) throw new AdportError('POLICY_VIOLATION', 'Audience sharing requires the authorized user to be Admin or Operator on the source advertiser.');
    return [...found.values()].sort((a, b) => a.asset_id.localeCompare(b.asset_id));
  }
  private async prepare(value: unknown) {
    const input = audienceSharingContext.parse(value);this.selection(input.account_id, input.shared_advertiser_ids);await this.authorizeAccounts([input.account_id, ...input.shared_advertiser_ids]);
    const accounts = await this.businessAccounts(input.bc_id, input.account_id, input.shared_advertiser_ids), audiences = await this.audiences.inspect(input.account_id, input.custom_audience_ids);audiences.forEach(row => this.owned(input.account_id, row, input.action === 'SHARE'));const logs = await this.logs(input.account_id, input.custom_audience_ids);
    const fingerprint = { input, accounts, audiences: audiences.map(row => ({ snapshot_hash: row.snapshot_hash, configuration: preserved(row) })), logs: [...logs].map(([id, rows]) => [id, rows.map(({ shared_advertiser_name: _name, ...row }) => row)]) };
    return { input, accounts, audiences, logs, context_hash: hash(fingerprint) };
  }
  async context(value: unknown) {
    const current = await this.prepare(value), selected = this.view(current.logs, current.input.shared_advertiser_ids);
    return { context_hash: current.context_hash, action: current.input.action, bc_id: current.input.bc_id, accounts: current.accounts, audiences: current.audiences, existing_pairs: selected, records: current.audiences.flatMap(row => current.input.shared_advertiser_ids.map(id => ({ custom_audience_id: row.audience_id, audience_name: row.name, recipient_advertiser_id: id, shared: selected.some(pair => pair.custom_audience_id === row.audience_id && pair.shared_advertiser_id === id) }))), notes: notices };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const share = op.tool === 'tiktok_share_custom_audiences';if (op.provider !== 'tiktok' || op.kind !== 'update' || !share && op.tool !== 'tiktok_unshare_custom_audience') throw new AdportError('INVALID_INPUT', 'Unsupported audience-sharing operation/provider kind.');
    const selected = share ? shareAudiences.parse(op.payload) : unshareAudience.parse(op.payload), input = share ? { account_id: op.accountId, ...shareAudiences.parse(selected), action: 'SHARE' as const } : { account_id: op.accountId, bc_id: selected.bc_id, custom_audience_ids: [unshareAudience.parse(selected).custom_audience_id], shared_advertiser_ids: [unshareAudience.parse(selected).shared_advertiser_id], action: 'UNSHARE' as const };
    const selection = audienceSharingContext.parse(Object.fromEntries(Object.entries(input).filter(([key]) => !['expected_context_hash', 'acknowledge_recipient_access'].includes(key))));
    if (canonical([...new Set(op.affectedAccountIds ?? [])].sort()) !== canonical([...selection.shared_advertiser_ids].sort())) throw new AdportError('POLICY_VIOLATION', 'All destination accounts must be bound to the shared policy operation.');
    const current = await this.prepare(selection);if (current.context_hash !== selected.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'Audience sharing, source configuration or account authority changed; read and preview again.');
    const existing = this.view(current.logs, selection.shared_advertiser_ids);
    if (share ? existing.length > 0 : existing.length !== 1) throw new AdportError('INVALID_INPUT', share ? 'A selected audience/recipient pair already appears in the sharing log. Reconcile partial outcomes and select only intended new pairs; do not replay sharing.' : 'The exact audience/recipient pair is not present in the current explicit sharing log.');
    const title = share ? 'Share custom audiences' : 'Revoke audience sharing';
    return { summary: title, changes: current.audiences.map(row => `${share ? '+' : '-'} ${row.name} · ${selection.shared_advertiser_ids.length} recipient(s)`), coercions: [], budgetDeltas: [], notes: notices, review: { provider: 'tiktok', accountId: op.accountId, kind: 'update', title, fields: [{ label: 'Business Center', after: selection.bc_id }, { label: 'Owned audiences', after: current.audiences.map(row => ({ id: row.audience_id, name: row.name, type: row.type })) }, { label: 'Recipient accounts', after: current.accounts.filter(row => row.asset_id !== op.accountId).map(row => ({ id: row.asset_id, name: row.asset_name })) }, { label: 'Audience access', before: share ? 'Not shared with selected recipients' : 'Shared with selected recipient', after: share ? 'Grant selected recipients access' : 'Revoke selected recipient access' }], notices }, execute: async () => {
      const outcomes: Array<{ custom_audience_id: string; shared_advertiser_id: string; observed: string }> = [];
      try {
        const body = share ? { advertiser_id: op.accountId, custom_audience_ids: selection.custom_audience_ids, shared_advertiser_ids: selection.shared_advertiser_ids } : { advertiser_id: op.accountId, custom_audience_id: selection.custom_audience_ids[0]!, shared_advertiser_id: selection.shared_advertiser_ids[0]! };
        await this.client.post(share ? 'dmp/custom_audience/share' : 'dmp/custom_audience/share/cancel', body);
        for (const audience of selection.custom_audience_ids) {
          const rows = await this.log(op.accountId, audience);
          for (const recipient of selection.shared_advertiser_ids) outcomes.push({ custom_audience_id: audience, shared_advertiser_id: recipient, observed: rows.some(row => row.shared_advertiser_id === recipient) ? 'PRESENT' : 'ABSENT' });
          const others = (values: Share[]) => values.filter(row => !selection.shared_advertiser_ids.includes(row.shared_advertiser_id)).map(row => row.shared_advertiser_id).sort();
          if (canonical(others(rows)) !== canonical(others(current.logs.get(audience)!))) throw invalid();
        }
        if (outcomes.some(row => row.observed !== (share ? 'PRESENT' : 'ABSENT'))) throw invalid();
        const after = await this.audiences.inspect(op.accountId, selection.custom_audience_ids);if (after.some(row => canonical(preserved(row)) !== canonical(preserved(current.audiences.find(before => before.audience_id === row.audience_id)!)))) throw invalid();
        return { applied: true, resourceIds: selection.custom_audience_ids, details: { state: share ? 'RECIPIENT_PAIRS_OBSERVED' : 'RECIPIENT_PAIR_ABSENT', outcomes, audience_configuration_preserved: true, audience_availability_verified: false, ads_changed: false, next_tool: 'tiktok_custom_audience_shares', next_arguments: { account_id: op.accountId, custom_audience_ids: selection.custom_audience_ids, shared_advertiser_ids: selection.shared_advertiser_ids } }, ...(share ? { warnings: ['Recipient pairs are present in the native sharing log. Audience targeting availability remains unverified; inspect native status before use.'] } : {}) };
      } catch (error) {
        const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
        throw new AdportError('PROVIDER_ERROR', 'Audience sharing outcome is unconfirmed. Reconcile every selected pair in the sharing log before a new preview. No mutation was retried.', { resourceIds: selection.custom_audience_ids, observed_pairs: outcomes, ...(Number.isSafeInteger(details.code) ? { native_code: details.code } : {}) });
      }
    } };
  }
}
