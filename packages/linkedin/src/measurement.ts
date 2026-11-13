import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import type { LinkedInAdsClient } from './client.js';
import type { LinkedInAdsProvider } from './provider.js';
import { accountUrn, linkedinId as id } from './schemas.js';
import { linkedinPageState } from './paging.js';

type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<WriteResult> };
const nativeId = z.union([id, z.number().int().positive().safe()]).transform(String), hash = z.string().regex(/^[a-f0-9]{64}$/);
const campaignUrn = z.string().regex(/^urn:li:sponsoredCampaign:[1-9]\d*$/), conversionUrn = z.string().regex(/^urn:lla:llaPartnerConversion:[1-9]\d*$/), tagUrn = z.string().regex(/^urn:tscp:insightTag:[1-9]\d*$/);
const websiteTypes = ['ADD_TO_CART', 'DOWNLOAD', 'INSTALL', 'KEY_PAGE_VIEW', 'LEAD', 'PURCHASE', 'SIGN_UP', 'OTHER'] as const;
const conversionTypes = [...websiteTypes, 'SAVE', 'START_CHECKOUT', 'SCHEDULE', 'VIEW_CONTENT', 'VIEW_VIDEO', 'ADD_BILLING_INFO', 'BOOK_APPOINTMENT', 'REQUEST_QUOTE', 'SEARCH', 'SUBSCRIBE', 'AD_CLICK', 'AD_VIEW', 'COMPLETE_SIGNUP', 'SUBMIT_APPLICATION', 'PHONE_CALL', 'INVITE', 'LOGIN', 'SHARE', 'DONATE', 'ADD_TO_LIST', 'START_TRIAL', 'OUTBOUND_CLICK', 'CONTACT', 'QUALIFIED_LEAD', 'MARKETING_QUALIFIED_LEAD', 'SALES_QUALIFIED_LEAD'] as const;
const extendedWindows = new Set(['SUBMIT_APPLICATION', 'PURCHASE', 'ADD_TO_CART', 'QUALIFIED_LEAD', 'LEAD', 'MARKETING_QUALIFIED_LEAD', 'SALES_QUALIFIED_LEAD']);
const windowDays = z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90), z.literal(180), z.literal(365)]);
const money = z.object({ currencyCode: z.string().regex(/^[A-Z]{3}$/), amount: z.string().max(100).regex(/^\d+(?:\.\d+)?$/) }).strict();
const rule = z.object({ matchType: z.enum(['EXACT', 'STARTS_WITH', 'CONTAINS']), matchValue: z.string().trim().min(1).max(4096) }).strict();
const rules = z.array(z.array(rule).min(1).max(100)).max(100);
const association = z.looseObject({ campaign: campaignUrn, conversion: conversionUrn, associatedAt: z.number().int().nonnegative().safe().optional() });
const conversion = z.looseObject({ id: nativeId, account: accountUrn, name: z.string(), type: z.string(), enabled: z.boolean(), conversionMethod: z.string().optional(), ownershipType: z.enum(['OWNED', 'SHARED']).optional(), attributionType: z.string().optional(), postClickAttributionWindowSize: z.number().int().nonnegative().optional(), viewThroughAttributionWindowSize: z.number().int().nonnegative().optional(), value: money.optional(), valueType: z.string().optional(), urlMatchRuleExpression: rules.optional(), campaigns: z.array(campaignUrn).optional(), associatedCampaigns: z.array(association).optional(), lastModified: z.number().int().nonnegative().safe().optional(), imagePixelTag: z.string().optional() });
const insightTag = z.looseObject({ id: nativeId, sponsoredAccounts: z.array(accountUrn).min(1), firstPartyTrackingEnabled: z.boolean(), tag: z.string().optional() });
const domain = z.looseObject({ domainName: z.string(), insightTag: tagUrn, blocked: z.boolean(), created: z.number().int().nonnegative().safe().optional(), lastCallbackAt: z.number().int().nonnegative().safe().optional() });
const paging = z.looseObject({ start: z.number().int().nonnegative().safe(), count: z.number().int().nonnegative().safe(), total: z.number().int().safe().optional(), links: z.array(z.looseObject({ rel: z.string(), href: z.string().optional() })).optional() });
const pageInput = { start: z.number().int().nonnegative().safe().default(0), count: z.number().int().min(1).max(100).default(50) };
const listInput = z.object({ account_id: id, ...pageInput, include_shared: z.boolean().default(false) }).strict();
const associationInput = z.object({ account_id: id, campaign_id: id, ...pageInput, complete_snapshot: z.boolean().default(false) }).strict();
const editable = { name: z.string().trim().min(1).max(200), type: z.enum(conversionTypes), enabled: z.boolean(), attribution_type: z.enum(['LAST_TOUCH_BY_CAMPAIGN', 'LAST_TOUCH_BY_CONVERSION']), post_click_window_days: windowDays, view_through_window_days: windowDays, value: money, value_type: z.enum(['DYNAMIC', 'FIXED', 'NO_VALUE']), url_match_rule_expression: rules };
const createInput = z.object({ expected_account_hash: hash, source: z.enum(['INSIGHT_TAG', 'CONVERSIONS_API']).default('INSIGHT_TAG'), name: editable.name, type: editable.type, enabled: editable.enabled.default(false), attribution_type: editable.attribution_type.default('LAST_TOUCH_BY_CAMPAIGN'), post_click_window_days: windowDays.default(30), view_through_window_days: windowDays.default(7), value: money.optional(), value_type: editable.value_type.optional(), url_match_rule_expression: rules.optional() }).strict();
const updateInput = z.object({ conversion_id: id, expected_snapshot_hash: hash, name: editable.name.optional(), type: editable.type.optional(), enabled: editable.enabled.optional(), attribution_type: editable.attribution_type.optional(), post_click_window_days: windowDays.optional(), view_through_window_days: windowDays.optional(), value: money.optional(), value_type: editable.value_type.optional(), url_match_rule_expression: rules.optional() }).strict().refine(input => Object.keys(editable).some(key => Object.hasOwn(input, key)), 'Supply conversion fields to change');
const tagCreateInput = z.object({ expected_account_hash: hash }).strict();
const tagUpdateInput = z.object({ insight_tag_id: id, expected_snapshot_hash: hash, first_party_tracking_enabled: z.boolean() }).strict();
const setAssociationInput = z.object({ campaign_id: id, conversion_id: id, associated: z.boolean(), expected_conversion_hash: hash, expected_associations_hash: hash }).strict();
const contextOutput = { account_id: id, currency: z.string().regex(/^[A-Z]{3}$/), account_snapshot_hash: hash };
const records = z.array(z.record(z.string(), z.unknown()));
const collectionOutput = <T extends z.ZodType>(element: T) => z.looseObject({ ...contextOutput, elements: z.array(element), records, paging: paging.optional(), complete: z.boolean().nullable(), truncated: z.boolean(), next_start: z.number().int().nonnegative().safe().optional(), notes: z.array(z.string()).optional() });
const conversionOutput = conversion.extend({ id, snapshot_hash: hash.optional(), editable: z.boolean().optional() });
const tagsOutput = z.object({ ...contextOutput, elements: z.array(insightTag.extend({ id, snapshot_hash: hash })).max(1), records, complete: z.literal(true), notes: z.array(z.string()) });
const singleConversionOutput = z.object({ ...contextOutput, conversion: conversion.extend({ id, snapshot_hash: hash }), records });
const associationsOutput = collectionOutput(association).extend({ campaign_id: id, associations_snapshot_hash: hash.optional() });
const writes = new Set(['linkedin_create_insight_tag', 'linkedin_update_insight_tag', 'linkedin_create_conversion', 'linkedin_update_conversion', 'linkedin_set_campaign_conversion']);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, key === 'amount' && typeof item === 'string' && /^\d+(?:\.\d+)?$/.test(item) ? item.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : canonical(item)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const matches = (actual: Record<string, unknown>, fields: Record<string, unknown>) => Object.entries(fields).every(([key, value]) => same(actual[key], value));
const selectedAccount = (account: string) => `urn:li:sponsoredAccount:${id.parse(account)}`;
const snapshot = (value: z.infer<typeof conversion>) => digest(Object.fromEntries(['id', 'account', 'name', 'type', 'enabled', 'conversionMethod', 'attributionType', 'postClickAttributionWindowSize', 'viewThroughAttributionWindowSize', 'value', 'valueType', 'urlMatchRuleExpression', 'urlRules', 'campaigns', 'associatedCampaigns', 'lastModified'].map(key => [key, value[key] ?? null])));
const tagSnapshot = (value: z.infer<typeof insightTag>) => digest({ id: value.id, sponsoredAccounts: value.sponsoredAccounts, firstPartyTrackingEnabled: value.firstPartyTrackingEnabled });
const notices = ['Local preview only. No tracking code is installed or executed and no conversion events are sent.', 'Native writes are not retried automatically. Reconcile returned resource IDs before a new approval after an uncertain result.'];

/** Marketing202608 conversion tracking and Conversions API contracts checked2026-11-05. */
export class LinkedInMeasurementService {
  constructor(private readonly client: LinkedInAdsClient, private readonly provider: LinkedInAdsProvider) {}
  supports(tool: string) { return writes.has(tool); }
  private async account(account: string) { const value = await this.provider.getAccount(id.parse(account)); return { account_id: account, currency: value.currency, account_snapshot_hash: digest({ id: value.id, currency: value.currency, status: value.status }) }; }
  private owned(account: string, value: z.infer<typeof conversion>, selected?: string) {
    if (value.account !== selectedAccount(account) || value.ownershipType === 'SHARED' || selected !== undefined && value.id !== selected || value.associatedCampaigns?.some(item => item.conversion !== `urn:lla:llaPartnerConversion:${value.id}`)) throw new AdportError('PROVIDER_ERROR', 'linkedin: conversion advertiser/ID mismatch or shared ownership');
    return { ...value, snapshot_hash: snapshot(value) };
  }
  private async ownedConversion(account: string, conversionId: string) { return this.owned(account, await this.client.get(`conversions/${id.parse(conversionId)}`, conversion, { account: selectedAccount(account) }), conversionId); }
  private conversionRecord(value: z.infer<typeof conversion>) { return { id: value.id, name: value.name, type: value.type, status: value.enabled ? 'Enabled' : 'Disabled', source: value.conversionMethod ?? 'Insight Tag', ...(value.value ? { value: `${value.value.amount} ${value.value.currencyCode}` } : {}), ...(value.postClickAttributionWindowSize !== undefined ? { click_window_days: value.postClickAttributionWindowSize } : {}), ...(value.viewThroughAttributionWindowSize !== undefined ? { view_window_days: value.viewThroughAttributionWindowSize } : {}) }; }
  async conversions(raw: z.input<typeof listInput>) {
    const input = listInput.parse(raw), context = await this.account(input.account_id);
    const result = await this.client.get('conversions', z.looseObject({ elements: z.array(conversion), paging: paging.optional() }), { q: 'account', account: selectedAccount(input.account_id), start: input.start, count: input.count, ...(input.include_shared ? { conversionOwnershipTypes: ['OWNED', 'SHARED'] } : {}) });
    const elements = result.elements.map(value => input.include_shared && value.ownershipType === 'SHARED' ? { ...value, editable: false } : { ...this.owned(input.account_id, value), editable: true });
    if (new Set(elements.map(value => value.id)).size !== elements.length) throw new AdportError('PROVIDER_ERROR', 'linkedin: conversion finder repeated an identity');
    return { ...context, ...result, elements, records: elements.map(value => this.conversionRecord(value)), ...linkedinPageState(result, input.start, input.count, 'conversions') };
  }
  async getConversion(account: string, conversionId: string) { const context = await this.account(account), value = await this.ownedConversion(account, conversionId); return { ...context, conversion: value, records: [this.conversionRecord(value)] }; }
  private async tags(account: string) {
    const result = await this.client.get('insightTags', z.looseObject({ elements: z.array(insightTag).max(1), paging: paging.optional() }), { q: 'account', account: selectedAccount(account) });
    if (result.paging?.links?.some(link => link.rel === 'next') || result.elements.some(value => !value.sponsoredAccounts.includes(selectedAccount(account)) || new Set(value.sponsoredAccounts).size !== value.sponsoredAccounts.length)) throw new AdportError('PROVIDER_ERROR', 'linkedin: Insight Tag membership or single-tag finder mismatch');
    return result.elements.map(value => ({ ...value, snapshot_hash: tagSnapshot(value) }));
  }
  async insightTags(account: string) { const context = await this.account(account), elements = await this.tags(account); return { ...context, elements, records: elements.map(value => ({ id: value.id, first_party_tracking_enabled: value.firstPartyTrackingEnabled, associated_accounts: value.sponsoredAccounts, shared: value.sponsoredAccounts.length > 1 })), complete: true, notes: ['An advertiser has at most one Insight Tag. Returned tag code is inert text, never executed by the widget.', ...notices] }; }
  async domains(raw: { account_id: string; start?: number; count?: number }) {
    const input = z.object({ account_id: id, ...pageInput }).parse(raw), context = await this.account(input.account_id), tags = await this.tags(input.account_id);
    if (!tags.length) return { ...context, elements: [], records: [], complete: true, truncated: false };
    const result = await this.client.get('insightTagDomains', z.looseObject({ elements: z.array(domain), paging: paging.optional() }), { q: 'account', account: selectedAccount(input.account_id), start: input.start, count: input.count });
    if (result.elements.some(value => value.insightTag !== `urn:tscp:insightTag:${tags[0]!.id}`) || new Set(result.elements.map(value => value.domainName)).size !== result.elements.length) throw new AdportError('PROVIDER_ERROR', 'linkedin: Insight Tag domain identity mismatch');
    return { ...context, ...result, records: result.elements.map(value => ({ domain: value.domainName, status: value.blocked ? 'Blocked' : 'Allowed', ...(value.lastCallbackAt !== undefined ? { last_callback_at: value.lastCallbackAt } : {}) })), ...linkedinPageState(result, input.start, input.count, 'insightTagDomains') };
  }
  async campaignConversions(raw: z.input<typeof associationInput>) {
    const input = associationInput.parse(raw), context = await this.account(input.account_id); await this.provider.getCampaign(input.account_id, input.campaign_id);
    if (input.complete_snapshot) {
      if (input.start !== 0) throw new AdportError('INVALID_INPUT', 'linkedin: a complete campaign-conversion snapshot starts at zero');
      const elements = await this.completeAssociations(input.account_id, input.campaign_id);
      return { ...context, campaign_id: input.campaign_id, elements, records: elements.slice(0, 100).map(value => ({ conversion: value.conversion, campaign: value.campaign, ...(value.associatedAt !== undefined ? { associated_at: value.associatedAt } : {}) })), complete: true, truncated: false, associations_snapshot_hash: digest(elements), notes: [`Verified ${elements.length} associations across bounded native pages. The widget shows at most 100 records; elements retains the complete collection.`] };
    }
    const result = await this.client.get('campaignConversions', z.looseObject({ elements: z.array(association), paging: paging.optional() }), { q: 'campaigns', campaigns: [`urn:li:sponsoredCampaign:${input.campaign_id}`], start: input.start, count: input.count });
    if (result.elements.some(value => value.campaign !== `urn:li:sponsoredCampaign:${input.campaign_id}`) || new Set(result.elements.map(value => value.conversion)).size !== result.elements.length) throw new AdportError('PROVIDER_ERROR', 'linkedin: campaign-conversion scope or duplicate identity mismatch');
    const state = linkedinPageState(result, input.start, input.count, 'campaignConversions');
    return { ...context, campaign_id: input.campaign_id, ...result, records: result.elements.map(value => ({ conversion: value.conversion, campaign: value.campaign, ...(value.associatedAt !== undefined ? { associated_at: value.associatedAt } : {}) })), ...state, ...(state.complete === true ? { associations_snapshot_hash: digest(result.elements) } : {}) };
  }
  private async completeAssociations(account: string, campaign: string) {
    const values: z.infer<typeof association>[] = [], seen = new Set<string>(); let start = 0, knownTotal: number | undefined;
    for (let pages = 0; pages < 50; pages++) {
      const page = await this.campaignConversions({ account_id: account, campaign_id: campaign, start, count: 100 });
      if ('paging' in page && page.paging?.total !== undefined && page.paging.total >= 0) {
        if (knownTotal !== undefined && knownTotal !== page.paging.total) throw new AdportError('PROVIDER_ERROR', 'linkedin: campaign-conversion total changed during pagination');
        knownTotal = page.paging.total;
      }
      for (const value of page.elements) { if (seen.has(value.conversion)) throw new AdportError('PROVIDER_ERROR', 'linkedin: repeated campaign-conversion membership'); seen.add(value.conversion); values.push(value); }
      if (!('next_start' in page) || page.next_start === undefined) { if (page.complete === null || knownTotal !== undefined && values.length !== knownTotal) throw new AdportError('PROVIDER_ERROR', 'linkedin: campaign-conversion membership completeness is unknown or contradicts its total'); return values; }
      start = page.next_start;
    }
    throw new AdportError('PROVIDER_ERROR', 'linkedin: campaign-conversion membership exceeded 5,000; no write attempted');
  }
  private validateConfiguration(source: string, type: string, windows: number[], valueType?: string, value?: z.infer<typeof money>, expression?: z.infer<typeof rules>) {
    if (source === 'CONVERSIONS_API') {
      if (expression !== undefined || windows.some(days => days > 90 && !extendedWindows.has(type)) || valueType === 'FIXED' && !value) throw new AdportError('INVALID_INPUT', 'linkedin: invalid Conversions API URL rules, attribution window or value configuration');
    } else if (!(websiteTypes as readonly string[]).includes(type) || windows.some(days => ![1, 7, 30].includes(days)) || valueType !== undefined) throw new AdportError('INVALID_INPUT', 'linkedin: Insight Tag rules use documented website types and 1/7/30-day windows; value_type is Conversions API only');
  }
  private async verified(resource: string, check: () => Promise<boolean>) {
    try { if (!await check()) throw new Error('settings mismatch'); }
    catch { throw new AdportError('PROVIDER_ERROR', 'linkedin: measurement write readback unconfirmed; reconcile returned resource ID before another approval', { resource_ids: [resource] }); }
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const create = ['linkedin_create_conversion', 'linkedin_create_insight_tag'].includes(op.tool);
    if (op.provider !== 'linkedin' || !writes.has(op.tool) || op.kind !== (create ? 'create' : 'update')) throw new AdportError('INVALID_INPUT', 'linkedin: measurement operation kind mismatch');
    const context = await this.account(op.accountId), base = { notes: notices, coercions: [], budgetDeltas: [] };
    if (op.tool === 'linkedin_create_insight_tag') {
      const input = tagCreateInput.parse(op.payload);
      if (input.expected_account_hash !== context.account_snapshot_hash || (await this.tags(op.accountId)).length) throw new AdportError('INVALID_INPUT', 'linkedin: advertiser changed or already has an Insight Tag; read current settings');
      const body = { sponsoredAccounts: [selectedAccount(op.accountId)] };
      return { ...base, summary: 'Create an unused LinkedIn Insight Tag', changes: [`+ ${JSON.stringify(body)}. Native first-party tracking defaults to true; no website installation is performed.`], review: {
        provider: 'linkedin', accountId: op.accountId, kind: 'create', title: 'Create Insight Tag',
        fields: [{ label: 'Account', after: op.accountId }, { label: 'First-party tracking (native default)', after: true }],
        notices: ['Creates an unused tag. No website code is installed and no conversion events are sent.'],
      }, execute: async () => {
        const resource = await this.client.create('insightTags', body);
        await this.verified(resource, async () => { const found = (await this.tags(op.accountId)).find(value => value.id === resource); return !!found && same(found.sponsoredAccounts, body.sponsoredAccounts); });
        return { applied: true, resourceIds: [resource] };
      } };
    }
    if (op.tool === 'linkedin_update_insight_tag') {
      const input = tagUpdateInput.parse(op.payload), current = (await this.tags(op.accountId)).find(value => value.id === input.insight_tag_id);
      if (!current || current.snapshot_hash !== input.expected_snapshot_hash) throw new AdportError('INVALID_INPUT', 'linkedin: Insight Tag identity or snapshot changed');
      if (current.sponsoredAccounts.length !== 1) throw new AdportError('INVALID_INPUT', 'linkedin: a shared Insight Tag needs multi-account authorization before changing its global tracking flag');
      if (current.firstPartyTrackingEnabled === input.first_party_tracking_enabled) throw new AdportError('INVALID_INPUT', 'linkedin: Insight Tag setting already matches');
      return { ...base, summary: 'Update LinkedIn Insight Tag first-party tracking', changes: [`~ firstPartyTrackingEnabled ${current.firstPartyTrackingEnabled} → ${input.first_party_tracking_enabled}. An installed tag uses this setting; no site code is installed here.`], review: {
        provider: 'linkedin', accountId: op.accountId, kind: 'update', title: 'Update Insight Tag', subject: `Tag ${input.insight_tag_id}`,
        fields: [{ label: 'First-party tracking', before: current.firstPartyTrackingEnabled, after: input.first_party_tracking_enabled }],
        notices: ['An installed tag uses this setting. No website code is installed here.'],
      }, execute: async () => {
        await this.client.update(`insightTags/${input.insight_tag_id}`, { firstPartyTrackingEnabled: input.first_party_tracking_enabled });
        await this.verified(input.insight_tag_id, async () => (await this.tags(op.accountId)).some(value => value.id === input.insight_tag_id && value.firstPartyTrackingEnabled === input.first_party_tracking_enabled));
        return { applied: true, resourceIds: [input.insight_tag_id] };
      } };
    }
    if (op.tool === 'linkedin_set_campaign_conversion') {
      const input = setAssociationInput.parse(op.payload), current = await this.ownedConversion(op.accountId, input.conversion_id), associations = await this.completeAssociations(op.accountId, input.campaign_id);
      if (current.snapshot_hash !== input.expected_conversion_hash || digest(associations) !== input.expected_associations_hash) throw new AdportError('INVALID_INPUT', 'linkedin: conversion or campaign associations changed; read both again');
      const associatedBefore = associations.some(value => value.conversion === `urn:lla:llaPartnerConversion:${input.conversion_id}`);
      if (associatedBefore === input.associated) throw new AdportError('INVALID_INPUT', 'linkedin: campaign-conversion association already matches');
      return { ...base, summary: `${input.associated ? 'Associate' : 'Detach'} LinkedIn conversion "${current.name}"`, changes: [`${input.associated ? '+' : '-'} Campaign ${input.campaign_id} ↔ conversion ${input.conversion_id}. Changes campaign measurement/optimization eligibility; campaign status and budget are preserved.`], review: {
        provider: 'linkedin', accountId: op.accountId, kind: 'update', title: input.associated ? 'Associate conversion' : 'Detach conversion', subject: current.name,
        fields: [{ label: 'Campaign', after: input.campaign_id }, { label: 'Conversion', after: input.conversion_id }, { label: 'Associated', before: associatedBefore, after: input.associated }],
        notices: ['Changes campaign measurement and optimization eligibility. Campaign status and budget are preserved.'],
      }, execute: async () => {
        await this.client.setCampaignConversion(input.campaign_id, input.conversion_id, input.associated);
        await this.verified(input.conversion_id, async () => (await this.completeAssociations(op.accountId, input.campaign_id)).some(value => value.conversion === `urn:lla:llaPartnerConversion:${input.conversion_id}`) === input.associated);
        return { applied: true, resourceIds: [input.conversion_id], details: { campaign_id: input.campaign_id, associated: input.associated } };
      } };
    }
    const input = create ? createInput.parse(op.payload) : updateInput.parse(op.payload), current = create ? undefined : await this.ownedConversion(op.accountId, (input as z.infer<typeof updateInput>).conversion_id);
    if (create && (input as z.infer<typeof createInput>).expected_account_hash !== context.account_snapshot_hash || current && current.snapshot_hash !== (input as z.infer<typeof updateInput>).expected_snapshot_hash) throw new AdportError('INVALID_INPUT', 'linkedin: advertiser or conversion snapshot changed; read current settings');
    const source = create ? (input as z.infer<typeof createInput>).source : current!.conversionMethod ?? 'INSIGHT_TAG';
    const type = input.type ?? current!.type, value = input.value ?? current?.value, valueType = input.value_type ?? current?.valueType;
    if (create || ['type', 'post_click_window_days', 'view_through_window_days', 'value_type', 'url_match_rule_expression'].some(key => Object.hasOwn(input, key))) this.validateConfiguration(source, type, [input.post_click_window_days ?? current!.postClickAttributionWindowSize ?? 30, input.view_through_window_days ?? current!.viewThroughAttributionWindowSize ?? 7], valueType, value, input.url_match_rule_expression);
    if (value && value.currencyCode !== context.currency) throw new AdportError('INVALID_INPUT', 'linkedin: conversion value currency must match the selected advertiser');
    const fields: Record<string, unknown> = {};
    for (const [key, native] of Object.entries({ name: 'name', type: 'type', enabled: 'enabled', attribution_type: 'attributionType', post_click_window_days: 'postClickAttributionWindowSize', view_through_window_days: 'viewThroughAttributionWindowSize', value: 'value', value_type: 'valueType', url_match_rule_expression: 'urlMatchRuleExpression' })) { const value = input[key as keyof typeof input]; if (value !== undefined) fields[native] = value; }
    if (create) { fields.account = selectedAccount(op.accountId); if (source === 'CONVERSIONS_API') fields.conversionMethod = source; }
    if (current && matches(current, fields)) throw new AdportError('INVALID_INPUT', 'linkedin: conversion fields already match');
    const labels: Record<string, string> = { name: 'Name', type: 'Type', enabled: 'Enabled', attributionType: 'Attribution type', postClickAttributionWindowSize: 'Post-click window (days)', viewThroughAttributionWindowSize: 'View-through window (days)', value: 'Value', valueType: 'Value type', urlMatchRuleExpression: 'URL match rules' };
    const observed = current as Record<string, unknown> | undefined;
    const reviewFields = Object.entries(fields).filter(([key]) => Object.hasOwn(labels, key) && !(create && key === 'name')).map(([key, value]) => ({ label: labels[key]!, ...(observed && Object.hasOwn(observed, key) && observed[key] !== undefined ? { before: observed[key] } : {}), after: value }));
    const scopeNotice = create ? `No campaign associations are created. ${source === 'INSIGHT_TAG' ? 'LinkedIn selects the native Insight Tag method from the URL rules. ' : ''}Omitted value settings use native defaults reported by readback.` : 'Only supplied settings change. Campaign associations are preserved; supplied URL rules replace the complete expression.';
    return { ...base, summary: `${create ? 'Create' : 'Update'} LinkedIn conversion "${input.name ?? current!.name}"`, changes: [`${create ? '+' : '~'} ${JSON.stringify(fields)}`, ...(create ? ['No autoAssociationType is sent; native default creates no campaign associations.'] : ['Only supplied fields change. URL expressions replace the complete expression; omitted settings and campaign associations remain unchanged.']), ...(source === 'CONVERSIONS_API' ? ['Conversions API access additionally requires native rw_conversions permission; no OAuth scopes are changed here.'] : [])], review: {
      provider: 'linkedin', accountId: op.accountId, kind: create ? 'create' : 'update', title: create ? 'Create conversion' : 'Update conversion', subject: current?.name ?? input.name,
      fields: [...(create ? [{ label: 'Source family', after: source }] : []), ...reviewFields], notices: [scopeNotice],
    }, execute: async () => {
      const resource = create ? await this.client.create('conversions', fields) : current!.id;
      if (!create) await this.client.partialUpdate(`conversions/${resource}`, { $set: fields }, { account: selectedAccount(op.accountId) });
      await this.verified(resource, async () => matches(await this.ownedConversion(op.accountId, resource), fields));
      return { applied: true, resourceIds: [resource] };
    } };
  }
}

export function linkedinMeasurementTools(provider: LinkedInAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'linkedin_insight_tags', namespace: 'linkedin', description: 'Read the selected advertiser’s single Insight Tag, associated accounts, inert tag code and current snapshot. Returns account_snapshot_hash for creation. Does not install tracking or send events.', input: z.object({ account_id: id }), output: tagsOutput, presentation: 'records', annotations: { readOnly: true }, handler: input => provider.measurement.insightTags(input.account_id) }),
    defineTool({ name: 'linkedin_insight_tag_domains', namespace: 'linkedin', description: 'Read domains and callback diagnostics for the advertiser’s verified Insight Tag with native offset paging. No tag execution or domain setting changes.', input: z.object({ account_id: id, ...pageInput }), output: collectionOutput(domain), presentation: 'records', annotations: { readOnly: true }, handler: input => provider.measurement.domains(input) }),
    defineTool({ name: 'linkedin_conversions', namespace: 'linkedin', description: 'List conversion rules and configuration snapshots using the selected advertiser finder and native offset paging. Disabled rules remain visible. Optional shared rules are read-only; no scope or tracking changes.', input: listInput, output: collectionOutput(conversionOutput), presentation: 'records', annotations: { readOnly: true }, handler: input => provider.measurement.conversions(input) }),
    defineTool({ name: 'linkedin_get_conversion', namespace: 'linkedin', description: 'Read one advertiser-owned conversion, its exact attribution/value/URL rules and snapshot_hash. Returned pixel code is inert text. No conversion event is sent.', input: z.object({ account_id: id, conversion_id: id }), output: singleConversionOutput, presentation: 'records', annotations: { readOnly: true }, handler: input => provider.measurement.getConversion(input.account_id, input.conversion_id) }),
    defineTool({ name: 'linkedin_campaign_conversions', namespace: 'linkedin', description: 'Read selected-campaign conversion associations with verified campaign ownership and native offset paging. complete_snapshot traverses up to 5,000 associations for a verified associations_snapshot_hash; the widget shows at most 100 rows.', input: associationInput, output: associationsOutput, presentation: 'records', annotations: { readOnly: true }, handler: input => provider.measurement.campaignConversions(input) }),
    guardedWriteTool({ name: 'linkedin_create_insight_tag', namespace: 'linkedin', provider: 'linkedin', kind: 'create', destructive: false, payload: tagCreateInput, description: 'Create the advertiser’s Insight Tag only if absent, using expected_account_hash from linkedin_insight_tags. Native first-party tracking defaults true; no code installation, scope changes or event sending. Verify native readback.' }),
    guardedWriteTool({ name: 'linkedin_update_insight_tag', namespace: 'linkedin', provider: 'linkedin', kind: 'update', destructive: true, payload: tagUpdateInput, description: 'Change first-party tracking on one unshared advertiser Insight Tag using its current snapshot. Shared global settings require separate multi-account authorization. No code installation or events; verify native readback.' }),
    guardedWriteTool({ name: 'linkedin_create_conversion', namespace: 'linkedin', provider: 'linkedin', kind: 'create', destructive: false, payload: createInput, description: 'Create an Insight Tag or Conversions API rule using expected_account_hash. Disabled by default, with explicit attribution windows and no automatic campaign association. CAPI needs native rw_conversions access. No tracking events or OAuth changes.' }),
    guardedWriteTool({ name: 'linkedin_update_conversion', namespace: 'linkedin', provider: 'linkedin', kind: 'update', destructive: true, payload: updateInput, description: 'Edit supplied conversion name, enabled state, type, attribution windows, exact-currency value or complete URL expression using expected_snapshot_hash. Omitted settings stay unchanged. enabled=false disables the rule; no invented rule DELETE endpoint.' }),
    guardedWriteTool({ name: 'linkedin_set_campaign_conversion', namespace: 'linkedin', provider: 'linkedin', kind: 'update', destructive: true, payload: setAssociationInput, description: 'Associate or detach an owned conversion from a verified advertiser campaign using current conversion and complete-association hashes. Native PUT/DELETE is independently read back. Status/budget unchanged; no events are sent.' }),
  ];
}
