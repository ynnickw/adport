import { AdportError, LocalMediaResolver, creativesOutput, defineTool, guardedWriteTool, mediaSourceFields, type AnyToolDefinition, type Creative, type MediaResolver, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { MicrosoftAdsClient, formatPartialErrors, type RequestScope } from './client.js';
import type { MicrosoftAdsProvider } from './provider.js';

type Row = Record<string, unknown>;
type ImagePlan = Omit<WritePreview, 'serverValidated'> & { execute: () => Promise<string[]> };
const id = z.string().regex(/^[1-9]\d*$/);
const imageType = z.enum(['GenericImage', 'Image16x9', 'Image15x10', 'Image4x3', 'Image12x10', 'Image1x1', 'Image191x100', 'Image4x1']);
const upload = z.object({ ...mediaSourceFields, image_type: imageType.default('GenericImage'), alt_text: z.string().max(1000).optional() })
  .refine(value => Boolean(value.media_id) !== Boolean(value.file_path), 'Choose media_id or file_path');
const image = z.object({ image_id: id });
const output = creativesOutput.extend({ images: z.array(z.record(z.string(), z.unknown())), next_page_index: z.number().int().nonnegative().optional() });
export const MICROSOFT_IMAGE_WRITES = new Set(['microsoft_upload_image', 'microsoft_delete_image']);
const rows = (value: unknown): Row[] => z.array(z.record(z.string(), z.unknown())).parse(value ?? []);
const nativeId = (value: unknown): string => {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) throw new AdportError('PROVIDER_ERROR', 'microsoft: unsafe native media ID');
  const parsed = id.safeParse(typeof value === 'number' ? String(value) : value);
  if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'microsoft: invalid native media ID');
  return parsed.data;
};

/** MicrosoftDocs/Advertising@fdee2fcf and official Python SDK@4b6fb31c; live-verified CSV flags. */
export class MicrosoftImageService {
  constructor(private readonly client: MicrosoftAdsClient, private readonly scope: (account: string) => Promise<RequestScope>, private readonly media: MediaResolver = new LocalMediaResolver()) {}

  private async request(account: string, path: string, body: Row, method: 'POST' | 'DELETE' = 'POST'): Promise<Row> {
    id.parse(account);
    const scope = await this.scope(account);
    if (!scope.customerId || scope.customerAccountId !== account) throw new AdportError('INVALID_INPUT', 'microsoft: account ownership could not be verified');
    const result = await this.client.request<Row>('campaign', method, path, body, scope);
    const errors = formatPartialErrors(result.PartialErrors as Parameters<typeof formatPartialErrors>[0]);
    if (errors) throw new AdportError('PROVIDER_ERROR', `microsoft: ${path}: ${errors}. Reconcile before retrying.`, { resourceIds: Array.isArray(result.MediaIds) ? result.MediaIds.filter(value => value !== null).map(nativeId) : [], partialErrors: result.PartialErrors });
    return result;
  }

  private async page(account: string, pageIndex: number, pageSize: number): Promise<Row[]> {
    const result = await this.request(account, 'MediaMetaData/QueryByAccountId', {
      MediaEnabledEntities: 'ImageAdExtension, ResponsiveAd', PageInfo: { Index: pageIndex, Size: pageSize }, ReturnAdditionalFields: 'Text',
    });
    if (!Object.hasOwn(result, 'MediaMetaData')) throw new AdportError('PROVIDER_ERROR', 'microsoft: image-library metadata was not returned');
    const images = rows(result.MediaMetaData);
    if (images.length > pageSize || new Set(images.map(value => nativeId(value.Id))).size !== images.length) throw new AdportError('PROVIDER_ERROR', 'microsoft: invalid image-library page');
    return images;
  }

  private async find(account: string, imageId: string): Promise<Row | undefined> {
    id.parse(imageId);
    const seen = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const values = await this.page(account, page, 1000);
      for (const value of values) {
        const key = nativeId(value.Id);
        if (seen.has(key)) throw new AdportError('PROVIDER_ERROR', 'microsoft: image-library pagination did not advance');
        seen.add(key);
      }
      const found = values.find(value => nativeId(value.Id) === imageId);
      if (found) return found;
      if (values.length < 1000) return;
    }
    throw new AdportError('PROVIDER_ERROR', 'microsoft: cannot verify image ownership within the 5000-image library scan limit');
  }

  private async owned(account: string, imageId: string): Promise<Row> {
    const result = await this.find(account, imageId);
    if (!result) throw new AdportError('INVALID_INPUT', 'microsoft: image was not found in the selected account library');
    return result;
  }

  private gallery(account: string, images: Row[], truncated: boolean, nextPage?: number) {
    const creatives: Creative[] = images.map(value => {
      const imageId = nativeId(value.Id), alt = typeof value.Text === 'string' ? value.Text : undefined;
      const representations = rows(value.Representations);
      const media: Creative['media'] = representations.flatMap(item => {
        if (typeof item.Url !== 'string') return [];
        try {
          const url = new URL(item.Url);
          if (url.protocol === 'https:' && !url.username && !url.password && url.hostname === 'www.bing.com') return [{ type: 'image' as const, url: item.Url, ...(alt ? { alt } : {}) }];
        } catch { /* Unsupported previews remain in native metadata. */ }
        return [];
      });
      return { id: imageId, account_id: account, provider: 'microsoft', name: `Image ${imageId}`, type: String(value.MediaType ?? 'IMAGE'), headlines: [], descriptions: alt ? [alt] : [], landing_urls: [], media, actions: [] };
    });
    return output.parse({ images, creatives, truncated, ...(nextPage !== undefined ? { next_page_index: nextPage } : {}) });
  }

  async list(input: { account_id: string; page_index: number; page_size: number }) {
    const images = await this.page(input.account_id, input.page_index, input.page_size);
    const truncated = images.length === input.page_size;
    return this.gallery(input.account_id, images, truncated, truncated ? input.page_index + 1 : undefined);
  }

  async get(input: { account_id: string; image_id: string }) {
    return this.gallery(input.account_id, [await this.owned(input.account_id, input.image_id)], false);
  }

  async lookupMany(account: string, imageIds: string[]) {
    const wanted = new Set(imageIds.map(value => id.parse(value))), found: Row[] = [], seen = new Set<string>();
    for (let page = 0; wanted.size && page < 5; page++) {
      const values = await this.page(account, page, 1000);
      for (const value of values) {
        const key = nativeId(value.Id);
        if (seen.has(key)) throw new AdportError('PROVIDER_ERROR', 'microsoft: image-library pagination did not advance');
        seen.add(key);
        if (wanted.delete(key)) found.push(value);
      }
      if (values.length < 1000) break;
    }
    return { ...this.gallery(account, found, wanted.size > 0), missing_image_ids: [...wanted] };
  }

  async extensionUses(input: { account_id: string; image_id: string }) {
    await this.owned(input.account_id, input.image_id);
    const result = await this.request(input.account_id, 'MediaAssociations/Query', { MediaEnabledEntities: 'ImageAdExtension', MediaIds: [input.image_id] });
    // The native response is one array of associations per requested media ID.
    if (!Array.isArray(result.MediaAssociations) || result.MediaAssociations.length !== 1 || !Array.isArray(result.MediaAssociations[0])) throw new AdportError('PROVIDER_ERROR', 'microsoft: image-extension associations were not returned');
    const associations = rows(result.MediaAssociations[0]);
    for (const value of associations) {
      nativeId(value.EntityId);
      if (nativeId(value.MediaId) !== input.image_id || value.MediaEnabledEntity !== 'ImageAdExtension') throw new AdportError('PROVIDER_ERROR', 'microsoft: image-extension association identity mismatch');
    }
    return { image_id: input.image_id, associations, coverage: 'ImageAdExtension only; ResponsiveAd uses are not returned by this API', truncated: false };
  }

  async plan(op: WriteOperation): Promise<ImagePlan> {
    id.parse(op.accountId);
    const expectedKind = op.tool === 'microsoft_upload_image' ? 'create' : 'remove';
    if (op.provider !== 'microsoft' || !MICROSOFT_IMAGE_WRITES.has(op.tool) || op.kind !== expectedKind) throw new AdportError('INVALID_INPUT', 'microsoft: image operation kind mismatch');
    if (op.tool === 'microsoft_upload_image') {
      const input = upload.parse(op.payload);
      // The native Image.Data limit is 102400 base64 characters.
      const file = await this.media.read(input, { maxBytes: 76800, contentTypes: ['image/png', 'image/jpeg', 'image/gif'] });
      return { summary: `Upload Microsoft image ${file.name}`, changes: [`+ ${input.image_type}; ${file.contentType}; ${file.bytes.byteLength} bytes; SHA-256 ${file.sha256}`, ...(input.alt_text !== undefined ? [`Image alt text: ${JSON.stringify(input.alt_text)}`] : []), 'Creates an unattached image. Microsoft validates dimensions and rejects animation; PNG images are converted to JPEG.'], coercions: [], budgetDeltas: [], execute: async () => {
        const result = await this.request(op.accountId, 'Media', { AccountId: op.accountId, Media: [{ Type: 'Image', MediaType: input.image_type, ...(input.alt_text !== undefined ? { Text: input.alt_text } : {}), Data: Buffer.from(file.bytes).toString('base64') }] });
        const created = Array.isArray(result.MediaIds) ? result.MediaIds.filter(value => value !== null).map(nativeId) : [];
        if (created.length !== 1) throw new AdportError('PROVIDER_ERROR', 'microsoft: image upload receipt mismatch; reconcile before retrying', { resourceIds: created });
        let readback: Row;
        try { readback = await this.owned(op.accountId, created[0]!); }
        catch { throw new AdportError('PROVIDER_ERROR', `microsoft: image ${created[0]} upload was accepted but library readback failed; reconcile before retrying`, { resourceIds: created }); }
        if (input.alt_text !== undefined && readback.Text !== input.alt_text) throw new AdportError('PROVIDER_ERROR', 'microsoft: uploaded image alt text was not confirmed; reconcile before retrying', { resourceIds: created });
        return created;
      } };
    }
    const input = image.parse(op.payload), current = await this.owned(op.accountId, input.image_id);
    const uses = await this.extensionUses({ account_id: op.accountId, image_id: input.image_id });
    if (uses.associations.length) throw new AdportError('INVALID_INPUT', 'microsoft: image is assigned to an image extension; remove the reference before deletion');
    return { summary: `Delete Microsoft image ${input.image_id}`, changes: [`- ${input.image_id}; type ${String(current.MediaType)}; alt text ${JSON.stringify(current.Text ?? null)}`, 'Permanent deletion. Microsoft atomically rejects images assigned to any image extension or responsive ad. The preflight association API covers image extensions only.'], coercions: [], budgetDeltas: [], execute: async () => {
      await this.request(op.accountId, 'Media', { AccountId: op.accountId, MediaIds: [input.image_id] }, 'DELETE');
      if (await this.find(op.accountId, input.image_id)) throw new AdportError('PROVIDER_ERROR', 'microsoft: image deletion was not confirmed; reconcile before retrying', { resourceIds: [input.image_id] });
      return [input.image_id];
    } };
  }
}

export function microsoftImageTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'microsoft_images', namespace: 'microsoft', description: 'View account-library image metadata, alt text and native image previews. Native page indexes start at zero; a full page may have a continuation.', input: z.object({ account_id: id, page_index: z.number().int().nonnegative().max(100000).default(0), page_size: z.number().int().positive().max(1000).default(20) }), output, presentation: 'creatives', pagination: { cursorInput: 'page_index', cursorOutput: 'next_page_index' }, annotations: { readOnly: true }, handler: input => provider.images.list(input) }),
    defineTool({ name: 'microsoft_get_library_image', namespace: 'microsoft', description: 'Read one image through the selected account library finder, including native alt text and previews. Ownership lookup is bounded to 5000 images.', input: z.object({ account_id: id, image_id: id }), output, presentation: 'creatives', annotations: { readOnly: true }, handler: input => provider.images.get(input) }),
    defineTool({ name: 'microsoft_image_extension_associations', namespace: 'microsoft', description: 'Read image-extension references for an account-owned image. This API does not return responsive-ad references; an empty result does not prove global non-use.', input: z.object({ account_id: id, image_id: id }), output: z.object({ image_id: id, associations: z.array(z.record(z.string(), z.unknown())), coverage: z.string(), truncated: z.boolean() }), annotations: { readOnly: true }, handler: input => provider.images.extensionUses(input) }),
    guardedWriteTool({ name: 'microsoft_upload_image', namespace: 'microsoft', provider: 'microsoft', kind: 'create', description: 'Upload a SHA-256-bound static image as an unattached account asset. Hosted calls require project media_id. Native cap 76800 bytes; PNG converts to JPEG. Alt text is set at creation; no serving association is created.', payload: upload }),
    guardedWriteTool({ name: 'microsoft_delete_image', namespace: 'microsoft', provider: 'microsoft', kind: 'remove', description: 'Permanently delete an account-owned image only if Microsoft verifies it is unassigned. Preflight checks image-extension uses; native deletion also rejects responsive-ad assignments.', payload: image }),
  ];
}
