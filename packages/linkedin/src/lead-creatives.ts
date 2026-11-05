import { createHash } from 'node:crypto';
import { AdportError, creativesOutput, defineTool, guardedWriteTool, type AnyToolDefinition, type Creative, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import type { LinkedInAdsClient } from './client.js';
import type { LinkedInAdsProvider } from './provider.js';
import { creativeUrn } from './creative-tools.js';
import { accountUrn, linkedinId } from './schemas.js';
import { leadFormId } from './lead-forms.js';

type Row = Record<string, unknown>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<WriteResult> };
const id = leadFormId, hash = z.string().regex(/^[a-f0-9]{64}$/);
export const leadCta = z.enum(['APPLY', 'DOWNLOAD', 'VIEW_QUOTE', 'LEARN_MORE', 'SIGN_UP', 'SUBSCRIBE', 'REGISTER', 'REQUEST_DEMO', 'JOIN', 'ATTEND', 'UNLOCK_FULL_DOCUMENT', 'SHOP_NOW', 'BUY_NOW', 'SEE_MORE']);
export const leadBinding = z.object({ form_id: id, expected_form_hash: hash, expected_campaign_hash: hash, label: leadCta, gated_preview_page_count: z.number().int().nonnegative().max(2147483647).optional(), confirm_public_post: z.literal(true).optional(), expected_source_hash: hash.optional() }).strict();
const selection = { creative_id: creativeUrn, expected_creative_hash: hash, form_id: id, expected_form_hash: hash, expected_campaign_hash: hash, label: leadCta };
const updateInput = z.object(selection).strict();
const native = z.looseObject({ id: creativeUrn, account: accountUrn, campaign: z.string().regex(/^urn:li:sponsoredCampaign:[1-9]\d*$/), intendedStatus: z.string(), content: z.record(z.string(), z.unknown()).optional(), leadgenCallToAction: z.looseObject({ destination: z.string().regex(/^urn:li:adForm:[1-9]\d*$/), label: z.string() }).optional() });
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
const select = (value: Row, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const aurn = (account: string) => `urn:li:sponsoredAccount:${linkedinId.parse(account)}`;
const postUrn = z.string().regex(/^urn:li:(?:share|ugcPost):[1-9]\d*$/);
const documentUrn = z.string().regex(/^urn:li:document:[A-Za-z0-9_-]+$/);
const terminal = new Set(['REMOVED', 'CANCELED', 'PENDING_DELETION', 'ARCHIVED']);
const formats: Record<string, string> = { STANDARD_UPDATE: 'LEAD_GENERATION_FORM_SPONSORED_CONTENT', SINGLE_VIDEO: 'VIDEO_LEAD_GENERATION_FORM_SPONSORED_CONTENT', CAROUSEL: 'LEAD_GENERATION_FORM_CAROUSEL_SPONSORED_CONTENT', SPONSORED_UPDATE_NATIVE_DOCUMENT: 'SPONSORED_UPDATE_NATIVE_DOCUMENT' };
const notices = ['Form configuration only; no submitted leads are accessed.', 'Changing an existing label can affect a serving ad. Changing the destination requires DRAFT; no creative or campaign is activated by this operation.'];

/** LinkedIn-owned Creatives, Lead Forms, Document Ads and campaign-objective contracts, 202608; checked 2026-11-05. */
export class LinkedInLeadCreativeService {
  constructor(private readonly client: LinkedInAdsClient, private readonly provider: LinkedInAdsProvider) {}
  supports(tool: string) { return tool === 'linkedin_set_creative_lead_form'; }
  campaignHash(campaign: Row) { return digest(select(campaign, ['id', 'account', 'status', 'type', 'format', 'objectiveType', 'associatedEntity'])); }
  creativeHash(creative: Row) { return digest(select(creative, ['id', 'account', 'campaign', 'intendedStatus', 'content', 'name', 'leadgenCallToAction'])); }
  sourceHash(creative: Row) { return digest(select(creative, ['id', 'account', 'campaign', 'content'])); }
  campaign(campaign: Row, contentFormat?: string) {
    if (campaign.type !== 'SPONSORED_UPDATES' || campaign.objectiveType !== 'LEAD_GENERATION' || !Object.values(formats).includes(String(campaign.format)) || contentFormat && campaign.format !== formats[contentFormat]) throw new AdportError('INVALID_INPUT', 'linkedin: choose a supported sponsored-content LEAD_GENERATION campaign matching the selected content format');
    if (terminal.has(String(campaign.status))) throw new AdportError('INVALID_INPUT', 'linkedin: lead-generation campaign is archived, canceled, removed or pending deletion');
  }
  private async form(account: string, formId: string, eligible = true) {
    const result = await this.provider.leadForms.get(account, id.parse(formId));
    if (eligible && !['DRAFT', 'PUBLISHED'].includes(result.form.state)) throw new AdportError('INVALID_INPUT', 'linkedin: lead form is not DRAFT or PUBLISHED');
    return result;
  }
  async createBinding(account: string, campaign: Row, raw: z.infer<typeof leadBinding>, contentFormat: string) {
    const input = leadBinding.parse(raw); this.campaign(campaign, contentFormat);
    if (this.campaignHash(campaign) !== input.expected_campaign_hash) throw new AdportError('PENDING_MISMATCH', 'linkedin: lead campaign changed; read lead-ad context again');
    const result = await this.form(account, input.form_id);
    if (result.form.snapshot_hash !== input.expected_form_hash) throw new AdportError('PENDING_MISMATCH', 'linkedin: lead form changed; read lead-ad context again');
    if (contentFormat !== 'SPONSORED_UPDATE_NATIVE_DOCUMENT' && input.gated_preview_page_count !== undefined) throw new AdportError('INVALID_INPUT', 'linkedin: gated preview pages apply only to document lead ads');
    return { destination: `urn:li:adForm:${input.form_id}`, label: input.label };
  }
  async context(input: { account_id: string; form_id: string; campaign_id?: string; source_creative_id?: string }) {
    const form = await this.form(input.account_id, input.form_id);
    const campaign = input.campaign_id ? await this.provider.getCampaign(input.account_id, input.campaign_id) : undefined;
    if (campaign) this.campaign(campaign);
    const source = input.source_creative_id ? await this.provider.creatives.owned(input.account_id, input.source_creative_id) : undefined;
    return { ...form, ...(campaign ? { campaign, campaign_snapshot_hash: this.campaignHash(campaign) } : {}), ...(source ? { source_creative: source, source_snapshot_hash: this.sourceHash(source) } : {}), notes: [...form.notes, 'Use the returned form/campaign hashes for lead-ad creation. A source hash binds reference reuse; a lead-generation document must use freshly uploaded, unused document bytes.'] };
  }
  async get(account: string, creativeId: string, includePreview = false) {
    const creative = native.parse(await this.provider.creatives.owned(account, creativeId)), campaign = await this.provider.getCampaign(account, creative.campaign.split(':').at(-1)!);
    this.campaign(campaign);
    const form = creative.leadgenCallToAction ? await this.form(account, creative.leadgenCallToAction.destination.split(':').at(-1)!, false) : undefined;
    const hashes = { creative_snapshot_hash: this.creativeHash(creative), campaign_snapshot_hash: this.campaignHash(campaign) };
    const association = form ? [`Lead form: ${form.form.name}`, `Call to action: ${creative.leadgenCallToAction!.label.replaceAll('_', ' ')}`] : ['No lead form is attached.'];
    let base: Creative = { id: creative.id, provider: 'linkedin', account_id: account, campaign_id: String(campaign.id), name: typeof creative.name === 'string' ? creative.name : creative.id, type: 'LEAD_GENERATION', status: creative.intendedStatus, headlines: [], descriptions: association, landing_urls: [], media: [], actions: [] };
    const warnings: Array<{ provider: string; message: string }> = [];
    if (includePreview) {
      try {
        const metadata = await this.provider.sponsored.metadata(account, creativeId);
        if (this.creativeHash(metadata) !== hashes.creative_snapshot_hash) throw new Error('creative changed during preview');
        const card = this.provider.sponsored.metadataCard(account, metadata);
        base = { ...card, descriptions: [...card.descriptions, ...association], actions: [] };
        if (!metadata.metadata || metadata.preview_warning) warnings.push({ provider: 'linkedin', message: metadata.preview_warning ?? 'Native creative copy/media were not returned. Form association remains available.' });
      } catch { warnings.push({ provider: 'linkedin', message: 'Native creative preview could not be verified. Form association remains available; read it again before an edit.' }); }
    }

    return { account_id: account, creative, campaign, ...hashes, ...(form ? { form: form.form } : {}), creatives: [base], warnings, truncated: false, notes: [...notices, ...(creative.intendedStatus !== 'DRAFT' ? ['The form destination is immutable outside DRAFT. Use an agent to select a new form on an eligible DRAFT creative.'] : [])] };
  }
  async assertUnusedDocument(account: string, resource: string) {
    documentUrn.parse(resource);
    const seen = new Set<string>(), cursors = new Set<string>(), checkedPosts = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await this.client.get(`adAccounts/${linkedinId.parse(account)}/creatives`, z.looseObject({ elements: z.array(native), metadata: z.object({ nextPageToken: z.string().optional() }).optional() }), { q: 'criteria', intendedStatuses: ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED', 'CANCELED', 'PENDING_DELETION', 'REMOVED'], pageSize: 100, sortOrder: 'ASCENDING', ...(cursor ? { pageToken: cursor } : {}) });
      if (result.elements.length > 100 || result.elements.some(value => value.account !== aurn(account) || seen.has(value.id)) || new Set(result.elements.map(value => value.id)).size !== result.elements.length) throw new AdportError('PROVIDER_ERROR', 'linkedin: document-use scan returned foreign or repeated creative identities');
      const references = new Set<string>();
      const collect = (value: unknown) => {
        if (Array.isArray(value)) { value.forEach(collect); return; }
        if (!object(value)) return;
        for (const [key, child] of Object.entries(value)) {
          if (key === 'reference' || key === 'post') { const parsed = postUrn.safeParse(child); if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'linkedin: document-use reference shape is unconfirmed'); references.add(parsed.data); }
          else collect(child);
        }
      };
      for (const creative of result.elements) { seen.add(creative.id); collect(creative.content); }
      const wanted = [...references].filter(value => !checkedPosts.has(value)); let nextPost = 0, failure: unknown;
      await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, async () => {
        while (!failure && nextPost < wanted.length) {
          const postId = wanted[nextPost++]!;
          try {
            const post = await this.client.get(`posts/${encodeURIComponent(postId)}`, z.looseObject({ id: postUrn, content: z.record(z.string(), z.unknown()).optional() }), { viewContext: 'AUTHOR' });
            if (post.id !== postId) throw new AdportError('PROVIDER_ERROR', 'linkedin: document-use post ID mismatch');
            const media = object(post.content?.media) ? post.content.media : {};
            if (media.id === resource) throw new AdportError('INVALID_INPUT', 'linkedin: document is already referenced by a creative; upload a fresh document for this lead ad');
            checkedPosts.add(postId);
          } catch (error) { failure = error; }
        }
      }));
      if (failure) throw failure;
      const next = result.metadata?.nextPageToken;
      if (!next) return;
      if (!result.elements.length || cursors.has(next) || seen.size >= 5000) throw new AdportError('PROVIDER_ERROR', 'linkedin: document-use scan is incomplete or exceeded 5,000 creatives; uniqueness is unconfirmed');
      cursors.add(next); cursor = next;
    }
    throw new AdportError('PROVIDER_ERROR', 'linkedin: document-use scan did not finish; uniqueness is unconfirmed');
  }

  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'linkedin' || !this.supports(op.tool) || op.kind !== 'update') throw new AdportError('INVALID_INPUT', 'linkedin: lead creative operation kind mismatch');
    const input = updateInput.parse(op.payload), current = await this.get(op.accountId, input.creative_id), form = await this.form(op.accountId, input.form_id);
    if (current.creative_snapshot_hash !== input.expected_creative_hash || current.campaign_snapshot_hash !== input.expected_campaign_hash || form.form.snapshot_hash !== input.expected_form_hash) throw new AdportError('PENDING_MISMATCH', 'linkedin: creative, campaign or form changed; read current context again');
    if (terminal.has(current.creative.intendedStatus)) throw new AdportError('INVALID_INPUT', 'linkedin: creative is archived, canceled, removed or pending deletion');
    const previous = current.creative.leadgenCallToAction, wanted = { destination: `urn:li:adForm:${input.form_id}`, label: input.label };
    if (current.creative.intendedStatus !== 'DRAFT' && previous?.destination !== wanted.destination) throw new AdportError('INVALID_INPUT', 'linkedin: form destination can change only while a creative is DRAFT');
    if (digest(previous) === digest(wanted)) throw new AdportError('INVALID_INPUT', 'linkedin: form and label already match the requested values');
    const fields = [{ label: 'Lead form', before: previous?.destination ?? null, after: wanted.destination }, { label: 'Call to action', before: previous?.label ?? null, after: wanted.label }];
    return { summary: `Update LinkedIn creative lead form ${input.creative_id}`, changes: fields.map(value => `~ ${value.label}: ${JSON.stringify(value.before)} → ${JSON.stringify(value.after)}`), budgetDeltas: [], coercions: [], review: { provider: 'linkedin', accountId: op.accountId, kind: 'update', title: 'Edit lead form association', subject: current.creatives[0]!.name, fields, notices }, execute: async () => {
      await this.client.update(`adAccounts/${op.accountId}/creatives/${encodeURIComponent(input.creative_id)}`, { leadgenCallToAction: wanted });
      try {
        const readback = await this.provider.creatives.owned(op.accountId, input.creative_id);
        const expected = { ...current.creative, leadgenCallToAction: wanted };
        if (this.creativeHash(readback) !== this.creativeHash(expected)) throw new Error('creative config changed');
      } catch { throw new AdportError('PROVIDER_ERROR', 'linkedin: lead creative write readback unconfirmed; reconcile resource ID before a new approval', { resource_ids: [input.creative_id] }); }
      return { applied: true, resourceIds: [input.creative_id], details: { lead_form_id: input.form_id, intended_status: current.creative.intendedStatus, next_tool: 'linkedin_creative_lead_form' } };
    } };
  }
}

export function linkedinLeadCreativeTools(provider: LinkedInAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'linkedin_lead_ad_context', namespace: 'linkedin', description: 'Read an advertiser-owned lead form plus optional supported LEAD_GENERATION campaign/source creative, with creation hashes. No submitted leads. Native Page permissions are separate from form access.', input: z.object({ account_id: linkedinId, form_id: id, campaign_id: linkedinId.optional(), source_creative_id: creativeUrn.optional() }).strict(), output: z.looseObject({ account_id: linkedinId, records: z.array(z.record(z.string(), z.unknown())) }), presentation: 'records', annotations: { readOnly: true }, handler: input => provider.leadCreatives.context(input) }),
    defineTool({ name: 'linkedin_creative_lead_form', namespace: 'linkedin', description: 'View a creative’s owned lead form, CTA and hashes, with verified native copy/media when available. Agents prepare label or DRAFT-destination edits for the normal native approval card.', input: z.object({ account_id: linkedinId, creative_id: creativeUrn }).strict(), output: creativesOutput.passthrough(), presentation: 'creatives', annotations: { readOnly: true }, handler: input => provider.leadCreatives.get(input.account_id, input.creative_id, true) }),
    guardedWriteTool({ name: 'linkedin_set_creative_lead_form', namespace: 'linkedin', provider: 'linkedin', kind: 'update', payload: updateInput, description: 'Attach/replace an owned lead form on a DRAFT creative, or edit the label of its existing form. Exact creative/campaign/form snapshots required. Preserves content and delivery status; label changes can affect serving ads. No publication, events or submitted leads.' }),
  ];
}
