import { AdportError, LocalMediaResolver, creativesOutput, defineTool, guardedWriteTool, mediaSourceFields, type AnyToolDefinition, type Creative, type MediaResolver, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { GoogleAdsRestClient, normalizeCustomerId } from './client.js';
import type { GoogleAdsProvider } from './provider.js';

type Row = Record<string, unknown>;
export interface GoogleAssetPlan extends Omit<WritePreview, 'serverValidated'> { execute: (validateOnly: boolean) => Promise<string[]> }
const id = z.string().regex(/^\d+$/);
const assetType = z.enum(['IMAGE', 'YOUTUBE_VIDEO', 'TEXT', 'SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET']);
const name = z.string().trim().min(1).max(128);
const url = z.string().url().refine(value => { const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; });
const sitelink = z.object({
  type: z.literal('SITELINK'), link_text: z.string().min(1).max(25),
  final_urls: z.array(url).min(1).max(10),
  description1: z.string().max(35).optional(), description2: z.string().max(35).optional(),
}).refine(value => (value.description1 !== undefined) === (value.description2 !== undefined), 'Provide both sitelink descriptions or neither');
const extension = z.discriminatedUnion('type', [
  sitelink,
  z.object({ type: z.literal('CALLOUT'), callout_text: z.string().min(1).max(25) }),
  z.object({ type: z.literal('STRUCTURED_SNIPPET'), header: z.string().min(1).max(25), values: z.array(z.string().min(1).max(25)).min(3).max(10) }),
]);
const createExtension = z.object({ name: name.optional(), content: extension });
const updateExtension = z.object({ asset_id: id, content: extension });
const uploadImage = z.object({ name: name.optional(), ...mediaSourceFields }).refine(value => Boolean(value.media_id) !== Boolean(value.file_path), 'Choose media_id or file_path');
const youtube = z.object({ name: name.optional(), youtube_video_id: z.string().regex(/^[A-Za-z0-9_-]{11}$/) });
export const GOOGLE_ASSET_WRITES = new Set(['google_create_extension_asset', 'google_update_extension_asset', 'google_upload_image_asset', 'google_create_youtube_asset', 'google_rename_asset']);
const fields = ['asset.resource_name', 'asset.id', 'asset.name', 'asset.type', 'asset.final_urls', 'asset.image_asset.full_size.url', 'asset.image_asset.file_size', 'asset.youtube_video_asset.youtube_video_id', 'asset.text_asset.text', 'asset.callout_asset.callout_text', 'asset.sitelink_asset.link_text', 'asset.sitelink_asset.description1', 'asset.sitelink_asset.description2', 'asset.structured_snippet_asset.header', 'asset.structured_snippet_asset.values', 'asset.policy_summary.approval_status', 'asset.policy_summary.review_status'];
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const urls = (value: unknown): string[] => Array.isArray(value) ? value.filter((value): value is string => url.safeParse(value).success) : [];

function extensionFields(content: z.infer<typeof extension>): Row {
  if (content.type === 'CALLOUT') return { calloutAsset: { calloutText: content.callout_text } };
  if (content.type === 'STRUCTURED_SNIPPET') return { structuredSnippetAsset: { header: content.header, values: content.values } };
  return { finalUrls: content.final_urls, sitelinkAsset: { linkText: content.link_text, ...(content.description1 !== undefined ? { description1: content.description1, description2: content.description2 } : {}) } };
}

/** Assets are shared; their associations, rather than the asset, are removable. */
export class GoogleAssetService {
  constructor(private readonly client: GoogleAdsRestClient, private readonly media: MediaResolver = new LocalMediaResolver()) {}

  private resource(account: string, asset: string) { return `customers/${normalizeCustomerId(account)}/assets/${id.parse(asset)}`; }
  async owned(account: string, asset: string): Promise<Row> {
    const resource = this.resource(account, asset);
    const rows = await this.client.search(account, `SELECT ${fields.join(', ')} FROM asset WHERE asset.id = ${id.parse(asset)} LIMIT 2`, { maxRows: 2 });
    const value = record(rows[0]?.asset);
    if (rows.length !== 1 || value.resourceName !== resource || value.id !== asset) throw new AdportError('INVALID_INPUT', 'google: asset is not owned by the selected account');
    return value;
  }
  async list(input: { account_id: string; asset_ids?: string[]; types?: string[]; after_asset_id?: string; limit: number }) {
    const account = normalizeCustomerId(input.account_id);
    const requestedIds = input.asset_ids?.map(value => id.parse(value)), requestedTypes = input.types?.map(value => assetType.parse(value));
    const after = input.after_asset_id === undefined ? undefined : id.parse(input.after_asset_id);
    const conditions = [requestedIds?.length ? `asset.id IN (${requestedIds.join(',')})` : '', requestedTypes?.length ? `asset.type IN (${requestedTypes.map(value => `'${value}'`).join(',')})` : '', after ? `asset.id > ${after}` : ''].filter(Boolean);
    const rows = await this.client.search(account, `SELECT ${fields.join(', ')} FROM asset${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY asset.id ASC LIMIT ${input.limit + 1}`, { maxRows: input.limit + 1 });
    const all = rows.map(row => record(row.asset));
    if (all.some(value => !id.safeParse(value.id).success || value.resourceName !== this.resource(account, String(value.id)) || (requestedIds?.length && !requestedIds.includes(String(value.id))) || (requestedTypes?.length && !requestedTypes.includes(value.type as z.infer<typeof assetType>)))) throw new AdportError('PROVIDER_ERROR', 'google: asset list returned an invalid ID or account, or an unexpected filter match');
    if (all.some((value, index) => BigInt(String(value.id)) <= BigInt(index ? String(all[index - 1]!.id) : after ?? '-1'))) throw new AdportError('PROVIDER_ERROR', 'google: asset pagination did not advance in native ID order');
    const assets = all.slice(0, input.limit);
    const creatives: Creative[] = assets.map(asset => {
      const image = record(asset.imageAsset), full = record(image.fullSize), link = record(asset.sitelinkAsset), callout = record(asset.calloutAsset), snippet = record(asset.structuredSnippetAsset), copy = record(asset.textAsset), policy = record(asset.policySummary);
      const candidate = text(full.url);
      let preview: string | undefined;
      if (candidate) { try { const parsed = new URL(candidate); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && (parsed.hostname === 'tpc.googlesyndication.com' || parsed.hostname.endsWith('.googleusercontent.com'))) preview = candidate; } catch {} }
      return { id: String(asset.id), provider: 'google', account_id: account, name: text(asset.name) || text(link.linkText) || text(callout.calloutText) || `Asset ${asset.id}`, type: String(asset.type ?? 'ASSET'), status: text(policy.approvalStatus) || undefined,
        headlines: [text(link.linkText) || text(callout.calloutText) || text(snippet.header) || text(copy.text)].filter(Boolean),
        descriptions: [text(link.description1), text(link.description2), ...(Array.isArray(snippet.values) ? snippet.values.filter((value): value is string => typeof value === 'string') : [])].filter(Boolean),
        landing_urls: urls(asset.finalUrls), media: preview ? [{ type: 'image', url: preview }] : [],
        actions: [{ label: 'Rename shared asset', tool: 'google_rename_asset', arguments: { account_id: account, asset_id: String(asset.id) }, fields: [{ key: 'name', label: 'Asset name', type: 'text', value: text(asset.name), max_length: 128 }] }],
      };
    });
    const truncated = rows.length > input.limit;
    return creativesOutput.extend({ assets: z.array(z.record(z.string(), z.unknown())) }).parse({ creatives, assets, truncated, ...(truncated && assets.length ? { next_cursor: String(assets.at(-1)!.id) } : {}) });
  }
  async plan(op: WriteOperation): Promise<GoogleAssetPlan> {
    const account = normalizeCustomerId(op.accountId), input = op.payload;
    const expectedKind = ['google_rename_asset', 'google_update_extension_asset'].includes(op.tool) ? 'update' : 'create';
    if (op.provider !== 'google' || op.kind !== expectedKind) throw new AdportError('INVALID_INPUT', 'google: asset operation kind mismatch');
    let operation: Row, changes: string[], summary: string;
    if (op.tool === 'google_upload_image_asset') {
      const parsed = uploadImage.parse(input), file = await this.media.read(parsed, { maxBytes: 5 * 1024 * 1024, contentTypes: ['image/png', 'image/jpeg', 'image/gif'] });
      operation = { create: { ...(parsed.name ? { name: parsed.name } : {}), imageAsset: { data: Buffer.from(file.bytes).toString('base64') } } };
      summary = 'Upload Google image asset'; changes = [`+ ${parsed.name || file.name}; ${file.contentType}; ${file.bytes.byteLength} bytes; SHA-256 ${file.sha256}`, 'Create an unattached asset. No ad, association, campaign or YouTube upload is created. Google assets cannot be deleted.'];
    } else if (op.tool === 'google_create_youtube_asset') {
      const parsed = youtube.parse(input); operation = { create: { ...(parsed.name ? { name: parsed.name } : {}), youtubeVideoAsset: { youtubeVideoId: parsed.youtube_video_id } } };
      summary = 'Reference an existing YouTube video as a Google asset'; changes = [`+ YouTube ${parsed.youtube_video_id}; name ${parsed.name ?? '(provider default)'}`, 'References an existing video; no video is uploaded or published and no ad is attached. Google assets cannot be deleted.'];
    } else if (op.tool === 'google_create_extension_asset') {
      const parsed = createExtension.parse(input), create = { ...(parsed.name ? { name: parsed.name } : {}), ...extensionFields(parsed.content) };
      operation = { create }; summary = `Create Google ${parsed.content.type} asset`; changes = [`+ ${JSON.stringify(create)}`, 'Unattached shared asset; serving entities are unchanged. Google assets cannot be deleted.'];
    } else if (op.tool === 'google_rename_asset') {
      const parsed = z.object({ asset_id: id, name }).parse(input), current = await this.owned(account, parsed.asset_id);
      operation = { update: { resourceName: this.resource(account, parsed.asset_id), name: parsed.name }, updateMask: 'name' };
      summary = `Rename Google asset ${parsed.asset_id}`; changes = [`~ name ${JSON.stringify(current.name ?? null)} → ${JSON.stringify(parsed.name)}`, 'Name only; shared content and serving associations are unchanged.'];
    } else if (op.tool === 'google_update_extension_asset') {
      const parsed = updateExtension.parse(input), current = await this.owned(account, parsed.asset_id);
      if (current.type !== parsed.content.type) throw new AdportError('INVALID_INPUT', 'google: extension type does not match the existing asset');
      const content = extensionFields(parsed.content);
      // Supplied sitelink descriptions update together; omission preserves both.
      const mask = parsed.content.type === 'CALLOUT' ? ['callout_asset.callout_text'] : parsed.content.type === 'STRUCTURED_SNIPPET' ? ['structured_snippet_asset.header', 'structured_snippet_asset.values']
        : ['final_urls', 'sitelink_asset.link_text', ...(parsed.content.description1 !== undefined ? ['sitelink_asset.description1', 'sitelink_asset.description2'] : [])];
      operation = { update: { resourceName: this.resource(account, parsed.asset_id), ...content }, updateMask: mask.join(',') };
      summary = `Update shared Google ${parsed.content.type} asset ${parsed.asset_id}`; changes = [`~ ${JSON.stringify(current)} → supplied content ${JSON.stringify(content)}`, 'Every ad using this shared asset can change, including active ads. Serving statuses and association membership are unchanged.'];
    } else throw new AdportError('INVALID_INPUT', 'google: unsupported asset write');
    return { summary, changes, coercions: [], budgetDeltas: [], execute: async validateOnly => {
      const result = await this.client.mutate(account, 'assets', [operation], { validateOnly });
      const resources = (result.results ?? []).flatMap(value => value.resourceName ? [value.resourceName] : []);
      if (!validateOnly && (resources.length !== 1 || !new RegExp(`^customers/${account}/assets/\\d+$`).test(resources[0]!))) throw new AdportError('PROVIDER_ERROR', 'google: asset mutation receipt mismatch; reconcile before retrying', { resource_ids: resources });
      return resources;
    } };
  }
}

export function googleAssetTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  const write = (name: string, description: string, payload: z.ZodObject, kind: 'create' | 'update') => guardedWriteTool({ name, namespace: 'google', provider: 'google', description, payload, kind });
  return [
    defineTool({ name: 'google_assets', namespace: 'google', description: 'View account-owned shared assets, extension copy, image previews and native policy status. Continue with next_cursor as after_asset_id and the same filters. Assets cannot be deleted; remove serving associations instead. Name edits use the normal preview/apply gate.', input: z.object({ account_id: z.string(), asset_ids: z.array(id).min(1).max(100).optional(), types: z.array(assetType).min(1).optional(), after_asset_id: id.optional(), limit: z.number().int().positive().max(200).default(50) }), output: creativesOutput.extend({ assets: z.array(z.record(z.string(), z.unknown())) }), annotations: { readOnly: true }, presentation: 'creatives', pagination: { cursorInput: 'after_asset_id' }, handler: input => provider.assets.list(input) }),
    write('google_upload_image_asset', 'Upload a SHA-256-bound PNG/JPEG/GIF as an unattached Google asset. Hosted calls require project media_id. Preview uses native validate_only. Assets cannot be deleted; no ad or serving association is created.', uploadImage, 'create'),
    write('google_create_youtube_asset', 'Reference an existing YouTube video ID as an unattached Google asset. Does not upload or publish a video or attach it to an ad. Assets cannot be deleted.', youtube, 'create'),
    write('google_create_extension_asset', 'Create an unattached sitelink, callout or structured-snippet asset with native server validation. Does not attach it to serving entities. Assets cannot be deleted.', createExtension, 'create'),
    write('google_rename_asset', 'Change only an account-owned shared asset name. Content and serving associations remain unchanged.', z.object({ asset_id: id, name }), 'update'),
    write('google_update_extension_asset', 'Update supplied shared extension content of the same type. All ads using this asset, including active ads, can change. Omitted sitelink descriptions are preserved. Preview is server-validated.', updateExtension, 'update'),
  ];
}
