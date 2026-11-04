import { createHash } from 'node:crypto';
import { AdportError, type Creative, type WriteGuard, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import { LinkedInAdsClient } from './client.js';
import { creativeUrn } from './creative-tools.js';
import type { LinkedInAdsProvider } from './provider.js';
import { accountUrn, linkedinId, NON_DISCRIMINATION_NOTICE, NON_POLITICAL_CONSENT } from './schemas.js';
import { archiveSponsoredPost, createReference, createSponsored, deleteSponsoredPost, LINKEDIN_SPONSORED_WRITES, organizationUrn, postCta, postSelection, postUrn, updateSponsoredPost } from './sponsored-tools.js';

type Row = Record<string, unknown>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<WriteResult> };
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const aurn = (account: string) => `urn:li:sponsoredAccount:${linkedinId.parse(account)}`;
const nativeCreative = z.looseObject({ id: creativeUrn, account: accountUrn, campaign: z.string().regex(/^urn:li:sponsoredCampaign:[1-9]\d*$/), intendedStatus: z.string(), content: z.record(z.string(), z.unknown()).optional(), metadata: z.looseObject({ adFormat: z.string().optional(), adHeadline: z.string().optional(), adIntroductionText: z.string().optional(), adLine: z.string().optional(), assetURL: z.string().optional(), landingPage: z.string().optional() }).optional() });
type CreativeMetadata = z.output<typeof nativeCreative> & { primary_media?: { type: 'image' | 'video'; url: string }; preview_warning?: string };
const nativePost = z.looseObject({ id: postUrn, author: organizationUrn, commentary: z.string(), lifecycleState: z.string(), distribution: z.looseObject({ feedDistribution: z.string(), thirdPartyDistributionChannels: z.array(z.string()).optional() }), content: z.record(z.string(), z.unknown()).optional() });
type Post = z.output<typeof nativePost>;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
const reference = (value: unknown) => { const content = row(value); return postUrn.parse(content.reference ?? row(content.documentAd).reference ?? row(content.standardUpdateAd).reference ?? row(content.videoAd).reference); };
const url = (value: unknown, media = false) => { if (typeof value !== 'string') return undefined; try { const parsed = new URL(value); return !parsed.username && !parsed.password && (media ? parsed.protocol === 'https:' && (parsed.hostname === 'licdn.com' || parsed.hostname.endsWith('.licdn.com')) : ['https:', 'http:'].includes(parsed.protocol)) ? value : undefined; } catch { return undefined; } };
const formats = { TEXT: 'STANDARD_UPDATE', IMAGE: 'STANDARD_UPDATE', ARTICLE: 'STANDARD_UPDATE', VIDEO: 'SINGLE_VIDEO', DOCUMENT: 'SPONSORED_UPDATE_NATIVE_DOCUMENT', CAROUSEL: 'CAROUSEL' } as const;
const terminal = (status: string) => ['REMOVED', 'CANCELED'].includes(status);
const contains = (actual: unknown, expected: unknown): boolean => Array.isArray(expected) ? Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => contains(actual[index], value)) : expected && typeof expected === 'object' ? Object.entries(expected).every(([key, value]) => contains(row(actual)[key], value)) : actual === expected;

/** LinkedIn-owned Posts/Creatives/Document/Carousel contracts reviewed 2026-11-04. */
export class LinkedInSponsoredService {
  constructor(private readonly client: LinkedInAdsClient, private readonly provider: LinkedInAdsProvider) {}

  async metadata(account: string, resource: string): Promise<CreativeMetadata> {
    linkedinId.parse(account); creativeUrn.parse(resource);
    const value = await this.client.creativeMetadata(`adAccounts/${account}/creatives/${encodeURIComponent(resource)}`, nativeCreative);
    if (value.id !== resource || value.account !== aurn(account)) throw new AdportError('INVALID_INPUT', 'linkedin: creative metadata account/ID mismatch');
    await this.provider.getCampaign(account, value.campaign.split(':').at(-1)!);
    if (value.metadata?.assetURL) {
      const visual = url(value.metadata.assetURL, true);
      try { const type = visual ? await this.client.creativeMediaType(visual) : undefined; if (visual && type) return { ...value, primary_media: { type, url: visual } }; }
      catch { /* Keep native copy and metadata when the primary CDN asset is unavailable. */ }
      return { ...value, preview_warning: 'Native primary asset MIME/readiness could not be verified on the allowed LinkedIn CDN. No media type is inferred from the ad format.' };
    }
    return value;
  }

  metadataCard(account: string, value: CreativeMetadata): Creative {
    const metadata = value.metadata, destination = url(metadata?.landingPage);
    return {
      id: value.id, provider: 'linkedin', account_id: account, campaign_id: value.campaign.split(':').at(-1)!, name: typeof value.name === 'string' ? value.name : value.id,
      type: metadata?.adFormat ?? 'SPONSORED_CONTENT_REFERENCE', status: value.intendedStatus,
      headlines: metadata?.adHeadline ? [metadata.adHeadline] : [], descriptions: [metadata?.adIntroductionText, metadata?.adLine].filter((v): v is string => Boolean(v)), landing_urls: destination ? [destination] : [],
      media: value.primary_media ? [value.primary_media] : [],
      actions: terminal(value.intendedStatus) || value.intendedStatus === 'PENDING_DELETION' ? [] : [
        { label: 'Pause or archive creative', tool: 'linkedin_set_creative_status', arguments: { account_id: account, creative_id: value.id }, fields: [{ key: 'status', label: 'Status', type: 'select', value: 'PAUSED', options: [{ label: 'Paused', value: 'PAUSED' }, { label: 'Archived', value: 'ARCHIVED' }] }] },
        { label: 'Rename creative', tool: 'linkedin_rename_creative', arguments: { account_id: account, creative_id: value.id }, fields: [{ key: 'name', label: 'Name', type: 'text', value: typeof value.name === 'string' ? value.name : '' }] },
      ],
    };
  }

  async preview(account: string, resource: string) {
    const value = await this.metadata(account, resource);
    return { items: [value], creatives: [this.metadataCard(account, value)], truncated: false, warnings: [...(value.metadata ? [] : [{ provider: 'linkedin', message: 'Native descriptive metadata was not returned; copy and previews remain unavailable. Post/source reads may require additional Page permissions.' }]), ...(value.preview_warning ? [{ provider: 'linkedin', message: value.preview_warning }] : [])] };
  }

  private async associations(account: string, post: string) {
    const items: z.output<typeof nativeCreative>[] = [], tokens = new Set<string>(), ids = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.client.get(`adAccounts/${linkedinId.parse(account)}/creatives`, z.looseObject({ elements: z.array(nativeCreative), metadata: z.object({ nextPageToken: z.string().optional() }).optional() }), { q: 'criteria', contentReferences: [postUrn.parse(post)], intendedStatuses: ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED', 'CANCELED', 'PENDING_DELETION', 'REMOVED'], sortOrder: 'ASCENDING', pageSize: 100, ...(token ? { pageToken: token } : {}) });
      if (result.elements.length > 100 || result.elements.some(value => value.account !== aurn(account) || reference(value.content) !== post || ids.has(value.id)) || new Set(result.elements.map(value => value.id)).size !== result.elements.length) throw new AdportError('PROVIDER_ERROR', 'linkedin: post associations account/reference/page mismatch');
      items.push(...result.elements); result.elements.forEach(value => ids.add(value.id));
      const next = result.metadata?.nextPageToken;
      if (!next) return items.sort((a, b) => a.id.localeCompare(b.id));
      if (!result.elements.length || tokens.has(next) || items.length >= 5000) throw new AdportError('PROVIDER_ERROR', 'linkedin: post associations are incomplete, repeated or exceed 5,000 creatives');
      tokens.add(next); token = next;
    }
    throw new AdportError('PROVIDER_ERROR', 'linkedin: post association page limit reached; membership is incomplete');
  }

  private async readPost(resource: string) {
    try {
      const post = await this.client.get(`posts/${encodeURIComponent(postUrn.parse(resource))}`, nativePost, { viewContext: 'AUTHOR' });
      if (post.id !== resource) throw new AdportError('PROVIDER_ERROR', 'linkedin: post readback returned a different ID');
      return post;
    }
    catch (error) { throw new AdportError('PROVIDER_ERROR', `linkedin: sponsored post read failed. Posts additionally require r_organization_social and an eligible Page role; existing advertising access does not imply that permission. ${error instanceof Error ? error.message : ''}`); }
  }

  private ownDarkPost(account: string, post: Post, author: string) {
    if (post.author !== author || row(post.adContext).dscAdAccount !== aurn(account) || post.distribution.feedDistribution !== 'NONE' || post.distribution.thirdPartyDistributionChannels?.length) throw new AdportError('INVALID_INPUT', 'linkedin: mutations require a selected-account dark post with the verified organization author and no organic/external distribution');
  }

  private async organization(account: string, author: string, campaignId?: string) {
    organizationUrn.parse(author);
    const value = campaignId ? await this.provider.getCampaign(account, campaignId) : await this.provider.getAccount(account);
    if ((campaignId ? value.associatedEntity : value.reference) !== author) throw new AdportError('PENDING_MISMATCH', 'linkedin: organization differs from the current owned account/campaign association');
  }

  async postContext(account: string, raw: z.input<typeof postSelection>) {
    const input = postSelection.parse(raw);
    let resource: string, author: string, campaignId: string | undefined;
    if (input.creative_id) {
      const source = await this.provider.creatives.owned(account, input.creative_id), campaign = await this.provider.getCampaign(account, source.campaign.split(':').at(-1)!);
      resource = reference(source.content); author = organizationUrn.parse(campaign.associatedEntity); campaignId = String(campaign.id);
    } else { resource = input.post_id!; author = input.author_organization!; campaignId = input.campaign_id; await this.organization(account, author, campaignId); }
    const post = await this.readPost(resource);
    if (post.id !== resource || post.author !== author || row(post.adContext).dscAdAccount !== undefined && row(post.adContext).dscAdAccount !== aurn(account)) throw new AdportError('INVALID_INPUT', 'linkedin: post ID/author/advertiser mismatch');
    if (!input.creative_id) this.ownDarkPost(account, post, author);
    const associations = await this.associations(account, resource), associationFacts = associations.map(value => ({ id: value.id, campaign: value.campaign, intendedStatus: value.intendedStatus, content: value.content }));
    const hashes = { post_snapshot_hash: hash(post), associations_snapshot_hash: hash(associationFacts) };
    const owned = row(post.adContext).dscAdAccount === aurn(account) && post.distribution.feedDistribution === 'NONE' && !post.distribution.thirdPartyDistributionChannels?.length;
    const media: Creative['media'] = [], content = row(post.content), primary = row(content.media), article = row(content.article), carousel = row(content.carousel);
    if (Array.isArray(carousel.cards) && carousel.cards.length > 10) throw new AdportError('PROVIDER_ERROR', 'linkedin: native carousel exceeds the supported ten-card contract');
    const entries = [primary, ...(article.thumbnail ? [{ id: article.thumbnail, title: article.title }] : []), ...(Array.isArray(carousel.cards) ? carousel.cards.map(value => row(row(value).media)) : [])].filter(value => typeof value.id === 'string');
    const ids = [...new Set(entries.map(value => String(value.id)))], previews = new Map<string, { type: 'image' | 'video'; url: string }>();
    const warnings: Array<{ provider: string; message: string }> = [];
    for (const id of ids) {
      try {
        const asset = id.startsWith('urn:li:image:') ? await this.provider.creatives.libraryImage(account, id) : id.startsWith('urn:li:video:') ? await this.provider.media.libraryVideo(account, id) : undefined;
        const preview = asset?.status === 'AVAILABLE' ? url(row(asset).downloadUrl, true) : undefined;
        if (preview) previews.set(id, { type: id.startsWith('urn:li:video:') ? 'video' : 'image', url: preview });
      } catch (error) { warnings.push({ provider: 'linkedin', message: `Post asset ${id} unavailable: ${error instanceof Error ? error.message : 'native read failed'}` }); }
    }
    for (const entry of entries) { const preview = previews.get(String(entry.id)); if (preview) media.push({ ...preview, ...(typeof entry.altText === 'string' || typeof entry.title === 'string' ? { alt: String(entry.altText ?? entry.title) } : {}) }); }
    const args = { account_id: account, post_id: post.id, author_organization: author, ...(campaignId ? { campaign_id: campaignId } : {}), expected_post_hash: hashes.post_snapshot_hash, expected_associations_hash: hashes.associations_snapshot_hash };
    const destinations = [post.contentLandingPage, article.source, ...(Array.isArray(carousel.cards) ? carousel.cards.map(value => row(value).landingPage) : [])].map(value => url(value)).filter((value): value is string => Boolean(value));
    const editFields: Creative['actions'][number]['fields'] = [{ key: 'commentary', label: 'Commentary shared by all linked creatives', type: 'text', value: post.commentary, max_length: 3000 }];
    if (typeof row(post.adContext).dscName === 'string' && String(row(post.adContext).dscName).trim()) editFields.push({ key: 'dsc_name', label: 'Shared post name', type: 'text', value: String(row(post.adContext).dscName), max_length: 200 });
    if (url(post.contentLandingPage) && !article.source) editFields.push({ key: 'landing_page', label: 'Shared post destination', type: 'text', value: String(post.contentLandingPage) });
    const cta = postCta.safeParse(post.contentCallToActionLabel);
    if (cta.success) editFields.push({ key: 'call_to_action', label: 'Shared post call to action', type: 'select', value: cta.data, options: postCta.options.map(value => ({ label: value.replaceAll('_', ' '), value })) });
    const card: Creative = {
      id: post.id, provider: 'linkedin', account_id: account, name: typeof row(post.adContext).dscName === 'string' ? String(row(post.adContext).dscName) : post.id,
      type: carousel.cards ? 'CAROUSEL_POST' : article.source ? 'ARTICLE_POST' : typeof primary.id === 'string' && primary.id.startsWith('urn:li:document:') ? 'DOCUMENT_POST' : 'SPONSORED_POST', status: post.lifecycleState,
      headlines: [primary.title, article.title].filter((value): value is string => typeof value === 'string'), descriptions: [post.commentary, ...(Array.isArray(carousel.cards) ? carousel.cards.map(value => row(row(value).media).title).filter((value): value is string => typeof value === 'string') : [])], landing_urls: destinations, media,
      actions: owned && row(post.adContext).dscStatus === 'ACTIVE' && post.lifecycleState === 'PUBLISHED' ? [{ label: `Edit shared post copy (${associations.length} linked creatives)`, tool: 'linkedin_update_sponsored_post', arguments: args, fields: editFields }] : [],
    };
    return { post, associations: associationFacts, ...hashes, creatives: [card], warnings, truncated: false };
  }

  private campaignFormat(campaign: Row, expected: string) {
    if (campaign.type !== 'SPONSORED_UPDATES' || campaign.format !== expected) throw new AdportError('INVALID_INPUT', `linkedin: this content requires a SPONSORED_UPDATES campaign with format ${expected}`);
    if (campaign.objectiveType === 'LEAD_GENERATION') throw new AdportError('INVALID_INPUT', 'linkedin: lead-generation creation/reuse requires dedicated account-owned form and single-use document checks');
    if (['REMOVED', 'CANCELED', 'PENDING_DELETION', 'ARCHIVED'].includes(String(campaign.status))) throw new AdportError('INVALID_INPUT', 'linkedin: parent campaign is archived, removed, canceled or pending deletion');
  }

  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const account = linkedinId.parse(op.accountId), create = ['linkedin_create_sponsored_ad', 'linkedin_create_reference_ad'].includes(op.tool);
    if (op.provider !== 'linkedin' || !LINKEDIN_SPONSORED_WRITES.has(op.tool) || op.kind !== (create ? 'create' : op.tool === 'linkedin_delete_sponsored_post' ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'linkedin: invalid sponsored content operation kind');
    const plan = (summary: string, changes: string[], execute: () => Promise<WriteResult>, coercions: string[] = []): Plan => ({ summary, changes, execute, coercions, budgetDeltas: [] });
    if (create) {
      const input = op.tool === 'linkedin_create_sponsored_ad' ? createSponsored.parse(op.payload) : createReference.parse(op.payload), campaign = await this.provider.getCampaign(account, input.campaign_id);
      const status = guard.forcePausedCreation ? 'PAUSED' : input.status;
      let fields: Row, postId: string | undefined, inlinePost: Row | undefined;
      if ('content' in input) {
        const content = input.content; this.campaignFormat(campaign, formats[content.type]);
        if (campaign.associatedEntity !== input.author_organization) throw new AdportError('PENDING_MISMATCH', 'linkedin: author differs from the current campaign organization');
        if (['WEBSITE_VISIT', 'WEBSITE_VISITS', 'WEBSITE_CONVERSION', 'WEBSITE_CONVERSIONS'].includes(String(campaign.objectiveType)) && !input.landing_page && content.type !== 'ARTICLE') throw new AdportError('INVALID_INPUT', 'linkedin: this campaign objective requires an explicit landing page');
        if (input.call_to_action && !input.landing_page && content.type !== 'ARTICLE') throw new AdportError('INVALID_INPUT', 'linkedin: a call to action requires a destination');
        const images = content.type === 'IMAGE' ? [content.image_id] : content.type === 'ARTICLE' && content.thumbnail ? [content.thumbnail] : content.type === 'CAROUSEL' ? content.cards.map(card => card.image_id) : [];
        for (const id of new Set(images)) if ((await this.provider.creatives.libraryImage(account, id)).status !== 'AVAILABLE') throw new AdportError('INVALID_INPUT', 'linkedin: image is not AVAILABLE');
        if (content.type === 'VIDEO') { const video = await this.provider.media.libraryVideo(account, content.video_id); if (video.status !== 'AVAILABLE' || video.owner !== input.author_organization) throw new AdportError('INVALID_INPUT', 'linkedin: video must be AVAILABLE and owned by the author organization'); }
        if (content.type === 'DOCUMENT' && (await this.provider.media.document(account, content.document_id)).status !== 'AVAILABLE') throw new AdportError('INVALID_INPUT', 'linkedin: document is not AVAILABLE');
        const nativeContent = content.type === 'TEXT' ? undefined : content.type === 'ARTICLE' ? { article: { source: content.source, title: content.title, ...(content.description !== undefined ? { description: content.description } : {}), ...(content.thumbnail ? { thumbnail: content.thumbnail } : {}) } } : content.type === 'CAROUSEL' ? { carousel: { cards: content.cards.map(card => ({ media: { id: card.image_id, title: card.title, ...(card.alt_text !== undefined ? { altText: card.alt_text } : {}) }, landingPage: card.landing_page })) } } : { media: { id: content.type === 'IMAGE' ? content.image_id : content.type === 'VIDEO' ? content.video_id : content.document_id, title: content.title, ...('alt_text' in content && content.alt_text !== undefined ? { altText: content.alt_text } : {}) } };
        const post = { author: input.author_organization, commentary: input.commentary, visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', distribution: { feedDistribution: 'NONE', targetEntities: [], thirdPartyDistributionChannels: [] }, isReshareDisabledByAuthor: true, adContext: { dscAdAccount: aurn(account), dscStatus: 'ACTIVE' }, ...(nativeContent ? { content: nativeContent } : {}), ...(input.landing_page ? { contentLandingPage: input.landing_page } : {}), ...(input.call_to_action ? { contentCallToActionLabel: input.call_to_action } : {}) };
        inlinePost = post;
        fields = { creative: { campaign: `urn:li:sponsoredCampaign:${input.campaign_id}`, intendedStatus: status, name: input.name, inlineContent: { post } } };
      } else {
        const source = await this.provider.creatives.owned(account, input.source_creative_id), parent = await this.provider.getCampaign(account, source.campaign.split(':').at(-1)!);
        const format = String(parent.format); this.campaignFormat(parent, format); this.campaignFormat(campaign, format);
        if (!Object.values(formats).includes(format as typeof formats[keyof typeof formats]) || !organizationUrn.safeParse(parent.associatedEntity).success || parent.associatedEntity !== campaign.associatedEntity) throw new AdportError('INVALID_INPUT', 'linkedin: source and destination sponsored campaigns must use a supported matching format and organization');
        postId = reference(source.content);
        fields = { campaign: `urn:li:sponsoredCampaign:${input.campaign_id}`, intendedStatus: status, name: input.name, content: format === formats.DOCUMENT ? { documentAd: { reference: postId } } : { reference: postId } };
      }
      const inline = 'creative' in fields;
      return plan(`Create LinkedIn ${inline ? 'sponsored ad and dark post' : 'post-reference ad'} “${input.name}”`, [NON_DISCRIMINATION_NOTICE, `Advertiser confirmation: ${NON_POLITICAL_CONSENT}`, ...(inline ? ['Native inline post uses lifecycle PUBLISHED and visibility PUBLIC; anyone with a direct URL may view it. feedDistribution NONE and disabled resharing prevent organic feed distribution. The new creative remains PAUSED under policy. Native Page permissions still apply.'] : ['Reuses an existing account creative’s post. Does not publish or edit another post.']), JSON.stringify(fields)], async () => {
        const resource = await this.client.createCreative(`adAccounts/${account}/creatives`, fields, inline ? { action: 'createInline' } : {});
        let postState: string | undefined;
        try {
          const value = await this.provider.creatives.owned(account, resource);
          if (value.campaign !== `urn:li:sponsoredCampaign:${input.campaign_id}` || value.intendedStatus !== status || value.name !== input.name || postId && reference(value.content) !== postId) throw new Error('creative receipt mismatch');
          postId = reference(value.content);
          if (inlinePost) {
            const post = await this.readPost(postId); this.ownDarkPost(account, post, String(inlinePost.author));
            if (!['PUBLISHED','PUBLISH_REQUESTED'].includes(post.lifecycleState) || post.visibility !== 'PUBLIC' || post.isReshareDisabledByAuthor !== true || post.commentary !== inlinePost.commentary || !contains(post.content, inlinePost.content) || ['contentLandingPage','contentCallToActionLabel'].some(key => inlinePost![key] !== undefined && post[key] !== inlinePost![key])) throw new Error('post copy, distribution, media or lifecycle did not match');
            postState = post.lifecycleState;
          }
        } catch { throw new AdportError('PROVIDER_ERROR', 'linkedin: sponsored creative was created but creative/post readback was not confirmed; post reads require native Page permission. Reconcile these IDs before any retry', { resource_ids: [resource, ...(postId ? [postId] : [])] }); }
        return { applied: true, resourceIds: [resource], details: { post_id: postId, intended_status: status, ...(postState ? { post_lifecycle_state: postState, post_readback_verified: true } : {}), next_tool: 'linkedin_creative_preview', note: inline ? 'The dark post is URL-accessible; no organic feed distribution was requested. Creative delivery is separate and remains paused when forced by policy.' : 'Existing post reused without another publication.' } };
      }, input.status !== status ? ['intendedStatus coerced to PAUSED by policy (paused_creation)'] : []);
    }
    const changes = op.tool === 'linkedin_update_sponsored_post' ? updateSponsoredPost.parse(op.payload) : undefined;
    const input = changes ?? (op.tool === 'linkedin_archive_sponsored_post' ? archiveSponsoredPost.parse(op.payload) : deleteSponsoredPost.parse(op.payload));
    const context = await this.postContext(account, { post_id: input.post_id, author_organization: input.author_organization, ...(input.campaign_id ? { campaign_id: input.campaign_id } : {}) });
    this.ownDarkPost(account, context.post, input.author_organization);
    if (context.post_snapshot_hash !== input.expected_post_hash || context.associations_snapshot_hash !== input.expected_associations_hash) throw new AdportError('PENDING_MISMATCH', 'linkedin: post content, processing or linked creative settings changed; read post context again');
    if (changes?.landing_page !== undefined && row(context.post.content?.article).source) throw new AdportError('INVALID_INPUT', 'linkedin: an article destination is its immutable article source; create a replacement article creative instead');
    if (changes?.call_to_action && !changes.landing_page && !url(context.post.contentLandingPage) && !url(row(context.post.content?.article).source)) throw new AdportError('INVALID_INPUT', 'linkedin: a call to action requires a current or explicitly supplied destination');
    const path = `posts/${encodeURIComponent(input.post_id)}`;
    if (op.tool === 'linkedin_delete_sponsored_post') {
      if (context.associations.some(value => !terminal(value.intendedStatus))) throw new AdportError('INVALID_INPUT', 'linkedin: remove or cancel all creative references before permanently deleting this post');
      return plan(`Delete LinkedIn dark post ${input.post_id}`, [`Permanently remove ${input.post_id}. Uploaded media is separate. References: ${JSON.stringify(context.associations)}`], async () => { await this.client.remove(path); return { applied: true, resourceIds: [input.post_id], details: { deletion: 'DELETED', uploaded_media_deleted: false } }; });
    }
    if (row(context.post.adContext).dscStatus !== 'ACTIVE' || context.post.lifecycleState !== 'PUBLISHED') throw new AdportError('INVALID_INPUT', 'linkedin: only an ACTIVE, PUBLISHED dark post can be edited or archived');
    const fields = changes ? { ...(changes.commentary !== undefined ? { commentary: changes.commentary } : {}), ...(changes.landing_page !== undefined ? { contentLandingPage: changes.landing_page } : {}), ...(changes.call_to_action !== undefined ? { contentCallToActionLabel: changes.call_to_action } : {}) } : {};
    const adFields = op.tool === 'linkedin_archive_sponsored_post' ? { dscStatus: 'ARCHIVED' } : changes?.dsc_name !== undefined ? { dscName: changes.dsc_name } : {};
    const patch = { ...(Object.keys(fields).length ? { $set: fields } : {}), ...(Object.keys(adFields).length ? { adContext: { $set: adFields } } : {}) };
    return plan(`${op.tool === 'linkedin_archive_sponsored_post' ? 'Irreversibly archive' : 'Edit shared'} LinkedIn dark post ${input.post_id}`, [`Affects all ${context.associations.length} linked creatives: ${JSON.stringify(context.associations)}`, ...(op.tool === 'linkedin_archive_sponsored_post' ? ['Native archiving cannot be undone and cancels associated creatives.'] : ['Only supplied copy/destination/CTA/name fields change. Media, author, distribution and lifecycle are preserved. Copy changes may trigger review.']), JSON.stringify(patch)], async () => {
      await this.client.partialUpdate(path, patch);
      try {
        const updated = await this.readPost(input.post_id); this.ownDarkPost(account, updated, input.author_organization);
        if (Object.entries(fields).some(([key, value]) => updated[key] !== value) || Object.entries(adFields).some(([key, value]) => row(updated.adContext)[key] !== value) || updated.lifecycleState !== context.post.lifecycleState || hash(updated.content) !== hash(context.post.content) || hash(updated.distribution) !== hash(context.post.distribution)) throw new Error('post readback mismatch');
        if (changes) { const linked = await this.associations(account, input.post_id); if (hash(linked.map(value => ({ id: value.id, campaign: value.campaign, intendedStatus: value.intendedStatus, content: value.content }))) !== context.associations_snapshot_hash) throw new Error('linked creative settings changed'); }
      } catch { throw new AdportError('PROVIDER_ERROR', 'linkedin: post mutation acknowledged but readback unconfirmed; reconcile before retrying', { resource_ids: [input.post_id] }); }
      return { applied: true, resourceIds: [input.post_id], details: { ...(op.tool === 'linkedin_archive_sponsored_post' ? { dsc_status: 'ARCHIVED', irreversible: true, linked_creative_cancellation: 'REQUESTED' } : { shared_post_updated: true }), affected_creative_ids: context.associations.map(value => value.id) } };
    });
  }
}
