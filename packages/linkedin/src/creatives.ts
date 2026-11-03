import { AdportError, LocalMediaResolver, type Creative, type MediaResolver, type WriteGuard, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import { LinkedInAdsClient, type RestliValue } from './client.js';
import type { LinkedInAdsProvider } from './provider.js';
import { createText, creativeStatus, creativeUrn, imageUrn, textAd, updateText, uploadImage } from './creative-tools.js';
import { accountUrn, linkedinId, NON_DISCRIMINATION_NOTICE, NON_POLITICAL_CONSENT } from './schemas.js';

type Row = Record<string, unknown>;
export interface LinkedInCreativePlan extends Omit<WritePreview, 'serverValidated'> { execute: () => Promise<WriteResult> }
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const campaignUrn = z.string().regex(/^urn:li:sponsoredCampaign:[1-9]\d*$/);
const creativeSchema = z.looseObject({ id: creativeUrn, account: accountUrn, campaign: campaignUrn, intendedStatus: z.string(), content: z.record(z.string(), z.unknown()).optional() });
const safeUrl = (value: unknown) => { if (typeof value !== 'string') return undefined; try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? value : undefined; } catch { return undefined; } };
const landingUrl = (value: unknown): string[] => { if (typeof value !== 'string') return []; try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? [value] : []; } catch { return []; } };
const aurn = (account: string) => `urn:li:sponsoredAccount:${linkedinId.parse(account)}`;

export class LinkedInCreativeService {
  constructor(private readonly client: LinkedInAdsClient, private readonly provider: LinkedInAdsProvider, private readonly media: MediaResolver = new LocalMediaResolver()) {}
  async owned(account: string, resource: string) {
    const value = await this.client.get(`adAccounts/${linkedinId.parse(account)}/creatives/${encodeURIComponent(creativeUrn.parse(resource))}`, creativeSchema);
    if (value.account !== aurn(account) || value.id !== resource) throw new AdportError('INVALID_INPUT', 'linkedin: creative account/ID mismatch');
    await this.provider.getCampaign(account, value.campaign.split(':').at(-1)!);
    return value;
  }
  async image(account: string, resource: string) {
    const value = await this.client.get(`images/${encodeURIComponent(imageUrn.parse(resource))}`, z.looseObject({ id: imageUrn, owner: z.string(), status: z.string(), downloadUrlExpiresAt: z.number().int().positive().max(8_640_000_000_000_000).optional(), mediaLibraryMetadata: z.looseObject({ associatedAccount: accountUrn }).optional() }));
    if (value.id !== resource || (value.owner !== aurn(account) && value.mediaLibraryMetadata?.associatedAccount !== aurn(account))) throw new AdportError('INVALID_INPUT', 'linkedin: image is not owned by or registered in the selected account');
    return value;
  }
  async list(input: { account_id: string; campaign_ids?: string[]; creative_ids?: string[]; statuses?: string[]; page_size: number; page_token?: string; include_media: boolean }) {
    const account = linkedinId.parse(input.account_id), params: Record<string, RestliValue> = { q: 'criteria', sortOrder: 'ASCENDING', pageSize: input.page_size, ...(input.page_token ? { pageToken: input.page_token } : {}), ...(input.campaign_ids?.length ? { campaigns: input.campaign_ids.map(id => `urn:li:sponsoredCampaign:${linkedinId.parse(id)}`) } : {}), ...(input.creative_ids?.length ? { creatives: input.creative_ids } : {}), intendedStatuses: input.statuses ?? ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED', 'CANCELED', 'PENDING_DELETION', 'REMOVED'] };
    const data = await this.client.get(`adAccounts/${account}/creatives`, z.looseObject({ elements: z.array(creativeSchema), metadata: z.object({ nextPageToken: z.string().optional() }).optional() }), params);
    if (data.elements.some(value => value.account !== aurn(account) || (input.campaign_ids?.length && !input.campaign_ids.some(id => value.campaign === `urn:li:sponsoredCampaign:${id}`)) || (input.creative_ids?.length && !input.creative_ids.includes(value.id)) || (input.statuses?.length && !input.statuses.includes(value.intendedStatus)))) throw new AdportError('PROVIDER_ERROR', 'linkedin: creative collection account/campaign/filter mismatch');
    const next = data.metadata?.nextPageToken;
    if (next && next === input.page_token) throw new AdportError('PROVIDER_ERROR', 'linkedin: creative pagination repeated its token');
    const images = new Map<string, Row>(), warnings: Array<{ provider: string; message: string }> = [], wanted = [...new Set(data.elements.map(value => record(value.content?.textAd).image).filter((value): value is string => typeof value === 'string'))]; let cursor = 0;
    if (input.include_media) await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, async () => { while (cursor < wanted.length) { const resource = wanted[cursor++]!; try { images.set(resource, await this.image(account, resource)); } catch (error) { warnings.push({ provider: 'linkedin', message: `Referenced image ${resource} unavailable: ${error instanceof Error ? error.message : 'native read failed'}` }); } } }));
    const creatives: Creative[] = data.elements.map(value => {
      const copy = record(value.content?.textAd), supported = textAd.safeParse(copy).success, image = images.get(String(copy.image)), url = safeUrl(image?.downloadUrl), args = { account_id: account, creative_id: value.id };
      const editable = !['REMOVED', 'PENDING_DELETION', 'CANCELED'].includes(value.intendedStatus), actions: Creative['actions'] = editable ? [{ label: 'Pause or archive creative', tool: 'linkedin_set_creative_status', arguments: args, fields: [{ key: 'status', label: 'Status', type: 'select', value: value.intendedStatus === 'ARCHIVED' ? 'ARCHIVED' : 'PAUSED', options: [{ label: 'Paused', value: 'PAUSED' }, { label: 'Archived', value: 'ARCHIVED' }] }] }, { label: 'Rename creative', tool: 'linkedin_rename_creative', arguments: args, fields: [{ key: 'name', label: 'Name', type: 'text', value: String(value.name ?? '') }] }] : [];
      if (supported && editable) actions.push({ label: 'Edit text-ad copy', tool: 'linkedin_update_text_ad', arguments: args, fields: [{ key: 'headline', label: 'Headline', type: 'text', value: String(copy.headline), max_length: 25 }, { key: 'description', label: 'Description', type: 'text', value: String(copy.description), max_length: 75 }, { key: 'landing_page', label: 'Destination', type: 'text', value: String(copy.landingPage) }] });
      return { id: value.id, provider: 'linkedin', account_id: account, name: String(value.name ?? value.id), type: supported ? 'TEXT_AD' : value.content?.reference ? 'SPONSORED_CONTENT_REFERENCE' : 'CREATIVE', status: value.intendedStatus, campaign_id: value.campaign.split(':').at(-1)!, headlines: typeof copy.headline === 'string' ? [copy.headline] : [], descriptions: typeof copy.description === 'string' ? [copy.description] : [], landing_urls: landingUrl(copy.landingPage), media: url ? [{ type: 'image', url, ...(typeof image?.downloadUrlExpiresAt === 'number' ? { expires_at: new Date(image.downloadUrlExpiresAt).toISOString() } : {}) }] : [], actions };
    });
    const referenceCount = data.elements.filter(value => value.content?.reference).length;
    if (referenceCount) warnings.push({ provider: 'linkedin', message: `${referenceCount} sponsored-content references returned. API version202608 does not inline their post copy/media; native references remain in items and need source-specific access.` });
    return { items: data.elements, creatives, warnings, truncated: Boolean(next), ...(next ? { next_page_token: next } : {}) };
  }
  private async update(account: string, resource: string, path: string, fields: Row, expected: Row): Promise<WriteResult> {
    await this.client.update(path, fields);
    try { const value = await this.owned(account, resource); if (!matches(value, expected)) throw new Error('settings did not match readback'); }
    catch { throw new AdportError('PROVIDER_ERROR', 'linkedin: creative update readback mismatch; reconcile before retrying', { resource_ids: [resource] }); }
    return { applied: true, resourceIds: [resource] };
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<LinkedInCreativePlan> {
    const account = linkedinId.parse(op.accountId), p = op.payload, create = ['linkedin_create_text_ad', 'linkedin_upload_image'].includes(op.tool), remove = op.tool === 'linkedin_delete_creative';
    if (op.provider !== 'linkedin' || op.kind !== (create ? 'create' : remove ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'linkedin: provider or creative operation kind mismatch');
    const plan = (summary: string, changes: string[], execute: () => Promise<WriteResult>, coercions: string[] = []): LinkedInCreativePlan => ({ summary, changes, execute, coercions, budgetDeltas: [] });
    if (op.tool === 'linkedin_upload_image') {
      const input = uploadImage.parse(p), file = await this.media.read(input, { maxBytes: 50 * 1024 * 1024, contentTypes: ['image/png', 'image/jpeg', 'image/gif'] });
      await this.provider.getAccount(account);
      return plan('Upload a LinkedIn account image', [`Initialize an account-owned native image and media-library entry; ${file.name}, ${file.bytes.byteLength} bytes; SHA-256 ${file.sha256}. Processing availability requires a later linkedin_get_image read.`], async () => {
        const init = await this.client.action('images', 'initializeUpload', { initializeUploadRequest: { owner: aurn(account), mediaLibraryMetadata: { associatedAccount: aurn(account), assetName: input.name } } }, z.object({ value: z.object({ image: imageUrn, uploadUrl: z.string().url(), uploadUrlExpiresAt: z.number().int().positive().safe() }) }));
        const value = init.value;
        try { if (value.uploadUrlExpiresAt <= Date.now()) throw new AdportError('PROVIDER_ERROR', 'linkedin: initialized image upload URL expired'); await this.client.uploadImage(value.uploadUrl, file.bytes); }
        catch (error) { throw new AdportError('PROVIDER_ERROR', error instanceof Error ? error.message : 'linkedin: image transfer failed', { resource_ids: [value.image] }); }
        return { applied: true, resourceIds: [value.image], details: { next_tool: 'linkedin_get_image', status: 'UPLOAD_ACCEPTED', note: 'Native upload acceptance does not prove processing readiness.' } };
      });
    }
    if (op.tool === 'linkedin_create_text_ad') {
      const input = createText.parse(p), campaign = await this.provider.getCampaign(account, input.campaign_id);
      if (campaign.type !== 'TEXT_AD') throw new AdportError('INVALID_INPUT', 'linkedin: text creatives require a TEXT_AD parent campaign');
      if (input.image && (await this.image(account, input.image)).status !== 'AVAILABLE') throw new AdportError('INVALID_INPUT', 'linkedin: image is not AVAILABLE');
      const status = guard.forcePausedCreation ? 'PAUSED' : input.status, fields = { campaign: `urn:li:sponsoredCampaign:${input.campaign_id}`, intendedStatus: status, ...(input.name ? { name: input.name } : {}), content: { textAd: { headline: input.headline, description: input.description, landingPage: input.landing_page, ...(input.image ? { image: input.image } : {}) } } };
      return plan('Create a LinkedIn text ad', [NON_DISCRIMINATION_NOTICE, `Advertiser confirmation: ${NON_POLITICAL_CONSENT}`, JSON.stringify(fields)], async () => { const resource = await this.client.createCreative(`adAccounts/${account}/creatives`, fields); try { if (!matches(await this.owned(account, resource), fields)) throw new Error('settings mismatch'); } catch { throw new AdportError('PROVIDER_ERROR', 'linkedin: created creative readback mismatch; reconcile before retrying', { resource_ids: [resource] }); } return { applied: true, resourceIds: [resource] }; }, status !== input.status ? ['intendedStatus coerced to PAUSED by policy (paused_creation)'] : []);
    }
    const resource = creativeUrn.parse(p.creative_id), current = await this.owned(account, resource), path = `adAccounts/${account}/creatives/${encodeURIComponent(resource)}`;
    if (['REMOVED', 'PENDING_DELETION', 'CANCELED'].includes(current.intendedStatus)) throw new AdportError('INVALID_INPUT', 'linkedin: creative is already removed, canceled or pending deletion');
    if (op.tool === 'linkedin_delete_creative') {
      const campaign = await this.provider.getCampaign(account, current.campaign.split(':').at(-1)!), direct = current.intendedStatus === 'DRAFT' || campaign.status === 'DRAFT';
      return plan(`${direct ? 'Delete' : 'Request deletion of'} LinkedIn creative ${resource}`, [direct ? 'Native DELETE removes this eligible draft/failed creative.' : 'Native PARTIAL_UPDATE sets intendedStatus PENDING_DELETION; this is a request, not proof of completed deletion.'], async () => { if (direct) { await this.client.remove(path); return { applied: true, resourceIds: [resource], details: { deletion: 'DELETED' } }; } const result = await this.update(account, resource, path, { intendedStatus: 'PENDING_DELETION' }, { intendedStatus: 'PENDING_DELETION' }); return { ...result, details: { deletion: 'PENDING_DELETION' } }; });
    }
    let fields: Row, updatePath = path;
    if (op.tool === 'linkedin_update_text_ad') {
      const input = updateText.parse(p), content = record(current.content), copy = textAd.safeParse(content.textAd);
      if (!copy.success || Object.keys(content).some(key => key !== 'textAd')) throw new AdportError('INVALID_INPUT', 'linkedin: current text-ad content has unsupported fields; refusing a partial replacement');
      if (input.image && (await this.image(account, input.image)).status !== 'AVAILABLE') throw new AdportError('INVALID_INPUT', 'linkedin: replacement image is not AVAILABLE');
      fields = { content: { textAd: { ...copy.data, ...(input.headline !== undefined ? { headline: input.headline } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.landing_page !== undefined ? { landingPage: input.landing_page } : {}), ...(input.image !== undefined ? { image: input.image } : {}) } } }; updatePath = `creatives/${encodeURIComponent(resource)}`;
    } else if (op.tool === 'linkedin_rename_creative') fields = { name: z.string().trim().min(1).max(200).parse(p.name) };
    else if (op.tool === 'linkedin_set_creative_status') { const input = creativeStatus.parse(p); if (input.status === 'ACTIVE' && !input.non_political_consent) throw new AdportError('INVALID_INPUT', `linkedin: activation requires explicit advertiser confirmation: ${NON_POLITICAL_CONSENT}`); fields = { intendedStatus: input.status }; }
    else throw new AdportError('INVALID_INPUT', `linkedin: unsupported creative write ${op.tool}`);
    const expected = { ...fields, ...(fields.intendedStatus === undefined ? { intendedStatus: current.intendedStatus } : {}) };
    return plan(`Update LinkedIn creative ${resource}`, [...(fields.intendedStatus === 'ACTIVE' ? [NON_DISCRIMINATION_NOTICE, `Advertiser confirmation: ${NON_POLITICAL_CONSENT}`] : []), `Current intendedStatus ${current.intendedStatus}; only supplied fields change. Copy changes can trigger review. ${JSON.stringify(fields)}`], () => this.update(account, resource, updatePath, fields, expected));
  }
}

function matches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) return actual !== null && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(expected).every(([key, value]) => matches((actual as Row)[key], value));
  return actual === expected;
}
