import { AdportError, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { SpotifyAdsClient } from './client.js';
import type { SpotifyCreativeService } from './creatives.js';
import { createAudience, createLookalike, createReport, deleteAudience, updateAudience } from './management-tools.js';
import { spotifyId } from './schemas.js';

type Row = Record<string, unknown>;
interface Plan extends Omit<WritePreview, 'serverValidated'> { execute: () => Promise<string[]> }
const object = z.record(z.string(), z.unknown());
const audienceSchema = z.looseObject({ id: spotifyId, type: z.enum(['CUSTOM', 'LOOKALIKE']), name: z.string() });
function query(input: Row) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(input)) if (value !== undefined) { if (Array.isArray(value)) value.forEach(item => params.append(key, String(item))); else params.set(key, String(value)); } return params; }

export class SpotifyManagementService {
  constructor(private readonly client: SpotifyAdsClient, private readonly creatives: SpotifyCreativeService) {}
  private base(account: string) { return `ad_accounts/${spotifyId.parse(account)}`; }
  async read(input: { account_id: string } & Row, path: string) { const { account_id, ...params } = input; return this.client.get(`${this.base(account_id)}/${path}`, object, query(params)); }
  async audiences(input: { account_id: string; limit: number; offset: number } & Row) { const { account_id: _account, limit: _limit, offset: _offset, ...params } = input; return this.creatives.page(input, 'audiences', 'audiences', params); }
  async insights(input: { account_id: string; ad_set_id: string } & Row) {
    const { ad_set_id, ...params } = input;
    await this.creatives.get(input.account_id, 'ad_sets', ad_set_id, false);
    return this.read({ ...params, entity_ids: [ad_set_id], entity_ids_type: 'AD_SET' }, 'insight_reports');
  }
  async audience(account: string, id: string) {
    const result = await this.client.get(`${this.base(account)}/audiences/${spotifyId.parse(id)}`, audienceSchema);
    if (result.id !== id || (result.ad_account_id !== undefined && result.ad_account_id !== account)) throw new AdportError('PROVIDER_ERROR', 'spotify: audience account/ID mismatch');
    return result;
  }
  async eligibleDatasets(input: { account_id: string; limit: number; q?: string }) {
    const result = await this.read(input, 'audiences/datasets');
    const data = z.looseObject({ datasets: z.array(z.looseObject({ id: spotifyId })), paging: z.looseObject({ total_results: z.number().int().nonnegative(), offset: z.number().int().nonnegative() }).optional() }).parse(result);
    return { ...data, truncated: data.paging ? data.paging.offset + data.datasets.length < data.paging.total_results : data.datasets.length === input.limit };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const base = this.base(op.accountId);
    let path: string, method: 'POST' | 'PATCH' = 'POST', body: Row, expected: string | undefined;
    switch (op.tool) {
      case 'spotify_create_report': {
        const input = createReport.parse(op.payload);
        for (const id of input.campaign_ids ?? []) await this.creatives.get(op.accountId, 'campaigns', id, false);
        return { summary: `Submit Spotify CSV export ${input.name}`, changes: [`+ export job ${JSON.stringify(input)}; no ad delivery changes`], coercions: [], budgetDeltas: [], execute: async () => { const result = await this.client.mutate(`${base}/async_reports`, 'POST', input, z.object({ id: spotifyId })); return [result.id]; } };
      }
      case 'spotify_create_audience': {
        const input = createAudience.parse(op.payload);
        if (input.subtype === 'WEB_EVENT') {
          const data = await this.eligibleDatasets({ account_id: op.accountId, limit: 50 });
          if (input.dataset_ids!.some(id => !data.datasets.some(dataset => dataset.id === id))) throw new AdportError('INVALID_INPUT', 'spotify: dataset is not present in the selected account’s eligible audience datasets.');
        }
        for (const id of input.campaign_ids ?? []) await this.creatives.get(op.accountId, 'campaigns', id, false);
        for (const id of input.ad_set_ids ?? []) await this.creatives.get(op.accountId, 'ad_sets', id, false);
        body = { ...input, audience_type: 'CUSTOM' }; path = `${base}/audiences`; break;
      }
      case 'spotify_create_lookalike_audience': {
        const input = createLookalike.parse(op.payload); await this.audience(op.accountId, input.seed_audience_id);
        body = { ...input, audience_type: 'LOOKALIKE' }; path = `${base}/audiences`; break;
      }
      case 'spotify_update_audience': {
        const input = updateAudience.parse(op.payload), current = await this.audience(op.accountId, input.audience_id);
        const { audience_id, ...patch } = input; expected = audience_id; body = { ...patch, audience_type: current.type }; path = `${base}/audiences/${audience_id}`; method = 'PATCH'; break;
      }
      case 'spotify_delete_audience': {
        const input = deleteAudience.parse(op.payload), current = await this.audience(op.accountId, input.audience_id);
        return { summary: `Delete Spotify audience ${current.name}`, changes: [`- account-owned audience ${current.id}; targeting dependencies may be affected`], coercions: [], budgetDeltas: [], execute: async () => { const result = await this.client.mutate(`${base}/audiences/${current.id}`, 'DELETE', undefined, z.object({ deletion_count: z.number().int().nonnegative() })); if (result.deletion_count !== 1) throw new AdportError('PROVIDER_ERROR', 'spotify: audience deletion did not confirm one removed record; inspect before retrying'); return [current.id]; } };
      }
      default: throw new AdportError('INVALID_INPUT', `spotify: unsupported write ${op.tool}`);
    }
    return { summary: `Spotify ${op.tool.replace(/^spotify_/, '').replaceAll('_', ' ')}`, changes: [`${method} /${path} ${JSON.stringify(body)}`], coercions: [], budgetDeltas: [], execute: async () => {
      const result = await this.client.mutate(path, method, body, audienceSchema);
      if ((expected && result.id !== expected) || result.type !== body.audience_type || (result.ad_account_id !== undefined && result.ad_account_id !== op.accountId)) throw new AdportError('PROVIDER_ERROR', 'spotify: audience mutation receipt mismatch; inspect before retrying');
      return [result.id];
    } };
  }
}
