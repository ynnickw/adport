import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { GoogleAdsRestClient, normalizeCustomerId } from './client.js';
import type { GoogleAdsProvider } from './provider.js';

type Row = Record<string, unknown>;
export type GoogleConversionPlan = Omit<WritePreview, 'serverValidated'> & { execute: (validateOnly: boolean) => Promise<string[]>; resultDetails?: () => unknown; resultWarnings?: () => string[] };
const id = z.string().regex(/^[1-9]\d*$/), hash = z.string().regex(/^[a-f0-9]{64}$/), currency = z.string().regex(/^[A-Z]{3}$/);
const category = z.enum(['DEFAULT', 'PAGE_VIEW', 'PURCHASE', 'SIGNUP', 'DOWNLOAD', 'ADD_TO_CART', 'BEGIN_CHECKOUT', 'SUBSCRIBE_PAID', 'PHONE_CALL_LEAD', 'SUBMIT_LEAD_FORM', 'BOOK_APPOINTMENT', 'REQUEST_QUOTE', 'GET_DIRECTIONS', 'OUTBOUND_CLICK', 'CONTACT', 'ENGAGEMENT', 'STORE_VISIT', 'STORE_SALE', 'QUALIFIED_LEAD', 'CONVERTED_LEAD', 'YOUTUBE_FOLLOW_ON_VIEWS']);
const valueSettings = z.object({ default_value: z.number().finite().optional(), default_currency_code: currency.or(z.literal('')).optional(), always_use_default_value: z.boolean().optional() }).refine(value => Object.values(value).some(item => item !== undefined), 'Supply a value setting');
const editable = { name: z.string().trim().min(1).optional(), category: category.optional(), counting_type: z.enum(['ONE_PER_CLICK', 'MANY_PER_CLICK']).optional(), primary_for_goal: z.boolean().optional(), click_through_lookback_window_days: z.number().int().positive().optional(), view_through_lookback_window_days: z.number().int().nonnegative().optional(), phone_call_duration_seconds: z.number().int().min(0).max(10000).optional(), value_settings: valueSettings.optional(), attribution_model: z.enum(['GOOGLE_ADS_LAST_CLICK', 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN', 'EXTERNAL']).optional() };
const reference = { conversion_action_id: id, expected_action_hash: hash };
const createAction = z.object({ ...editable, name: z.string().trim().min(1), type: z.enum(['UPLOAD_CLICKS', 'UPLOAD_CALLS', 'WEBPAGE']), category, counting_type: z.enum(['ONE_PER_CLICK', 'MANY_PER_CLICK']), primary_for_goal: z.boolean().default(false), expected_context_hash: hash });
const updateAction = z.object({ ...reference, ...editable }).refine(value => Object.entries(value).some(([key, item]) => !['conversion_action_id', 'expected_action_hash'].includes(key) && item !== undefined), 'Supply an editable field');
const statusAction = z.object({ ...reference, status: z.enum(['ENABLED', 'REMOVED']) });
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/).refine(value => {
  const date = new Date(value.replace(' ', 'T'));
  const parts = value.slice(0, 19).split(/[- :]/).map(Number), calendar = new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!, parts[3]!, parts[4]!, parts[5]!));
  return Number.isFinite(date.getTime()) && calendar.toISOString().slice(0, 19) === value.slice(0, 19).replace(' ', 'T');
}, 'Use a real date/time with an explicit numeric timezone offset');
const identifierSource = z.enum(['FIRST_PARTY', 'THIRD_PARTY']).optional();
const emailIdentifier = z.object({ hashed_email: hash, user_identifier_source: identifierSource }).strict();
const phoneIdentifier = z.object({ hashed_phone_number: hash, user_identifier_source: identifierSource }).strict();
const clickIdentifier = z.union([emailIdentifier, phoneIdentifier]);
const addressIdentifier = z.object({ address_info: z.object({ hashed_first_name: hash, hashed_last_name: hash, country_code: z.string().regex(/^[A-Z]{2}$/), postal_code: z.string().min(1), city: z.string().optional(), state: z.string().optional(), hashed_street_address: hash.optional() }).strict(), user_identifier_source: identifierSource }).strict();
const consent = z.object({ ad_user_data: z.enum(['GRANTED', 'DENIED']) }).strict();
const eventValue = { conversion_date_time: timestamp, conversion_value: z.number().finite(), currency_code: currency, consent: consent.optional() };
const opaque = z.string().min(1).max(4096);
const click = z.object({ ...eventValue, gclid: opaque.optional(), gbraid: opaque.optional(), wbraid: opaque.optional(), order_id: opaque.optional(), user_identifiers: z.array(clickIdentifier).min(1).max(5).optional(), external_attribution_data: z.object({ external_attribution_credit: z.number().min(0).max(1), external_attribution_model: z.string().min(1) }).strict().optional(), conversion_environment: z.enum(['APP', 'WEB']).optional(), customer_type: z.enum(['NEW', 'RETURNING']).optional(), cart_data: z.object({ merchant_id: id, feed_country_code: z.string().regex(/^[A-Z]{2}$/), feed_language_code: z.string().regex(/^[a-z]{2}$/), local_transaction_cost: z.number().finite().optional(), items: z.array(z.object({ product_id: z.string().min(1), quantity: z.number().int().positive(), unit_price: z.number().finite() }).strict()).min(1).max(1000) }).strict().optional() }).strict().superRefine((value, ctx) => {
  if (!value.gclid && !value.gbraid && !value.wbraid && !value.user_identifiers) ctx.addIssue({ code: 'custom', message: 'Supply captured click identifiers or hashed user identifiers' });
  if (value.user_identifiers && value.consent?.ad_user_data !== 'GRANTED') ctx.addIssue({ code: 'custom', message: 'Hashed user identifiers require an explicit GRANTED ad_user_data consent value' });
  if (value.user_identifiers && value.external_attribution_data) ctx.addIssue({ code: 'custom', message: 'External attribution with user identifiers would discard user data' });
  if (!value.gclid && (value.gbraid || value.wbraid) && (value.user_identifiers || value.cart_data)) ctx.addIssue({ code: 'custom', message: 'Braid-only imports do not support user identifiers or cart data; do not silently discard those fields' });
});
const call = z.object({ ...eventValue, caller_id: z.string().regex(/^\+[1-9]\d{1,14}$/), call_start_date_time: timestamp }).strict().refine(value => Date.parse(value.conversion_date_time.replace(' ', 'T')) > Date.parse(value.call_start_date_time.replace(' ', 'T')), 'Conversion time must be after call start');
const adjustmentTarget = { order_id: opaque.optional(), gclid_date_time_pair: z.object({ gclid: opaque, conversion_date_time: timestamp }).strict().optional(), adjustment_date_time: timestamp };
const adjustment = z.discriminatedUnion('adjustment_type', [
  z.object({ ...adjustmentTarget, adjustment_type: z.literal('RETRACTION') }).strict(),
  z.object({ ...adjustmentTarget, adjustment_type: z.literal('RESTATEMENT'), restatement_value: z.object({ adjusted_value: z.number().finite(), currency_code: currency.optional() }).strict() }).strict(),
  z.object({ ...adjustmentTarget, adjustment_type: z.literal('ENHANCEMENT'), order_id: opaque, user_identifiers: z.array(z.union([emailIdentifier, phoneIdentifier, addressIdentifier])).min(1).max(5), user_agent: z.string().min(1).max(4096).optional() }).strict(),
]).superRefine((value, ctx) => {
  if (!value.order_id && !value.gclid_date_time_pair) ctx.addIssue({ code: 'custom', message: 'Supply the original order_id or gclid/date-time pair' });
  if (value.adjustment_type !== 'ENHANCEMENT' && value.order_id && value.gclid_date_time_pair) ctx.addIssue({ code: 'custom', message: 'Choose one original-conversion identifier' });
  if (value.gclid_date_time_pair && Date.parse(value.adjustment_date_time.replace(' ', 'T')) <= Date.parse(value.gclid_date_time_pair.conversion_date_time.replace(' ', 'T'))) ctx.addIssue({ code: 'custom', message: 'Adjustment time must be after original conversion time' });
});
const clickUpload = z.object({ ...reference, conversions: z.array(click).min(1).max(2000), job_id: z.number().int().min(0).max(2147483647).optional() });
const callUpload = z.object({ ...reference, conversions: z.array(call).min(1).max(2000) });
const adjustmentUpload = z.object({ ...reference, adjustments: z.array(adjustment).min(1).max(2000), job_id: z.number().int().min(0).max(2147483647).optional() });
const actionFields = 'conversion_action.resource_name, conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.owner_customer, conversion_action.primary_for_goal, conversion_action.counting_type, conversion_action.click_through_lookback_window_days, conversion_action.view_through_lookback_window_days, conversion_action.phone_call_duration_seconds, conversion_action.value_settings.default_value, conversion_action.value_settings.default_currency_code, conversion_action.value_settings.always_use_default_value, conversion_action.attribution_model_settings.attribution_model, conversion_action.attribution_model_settings.data_driven_model_status, conversion_action.tag_snippets';
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const camel = (key: string) => key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
function wire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wire);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [camel(key), wire(item)]));
  return value;
}
export const GOOGLE_CONVERSION_WRITES = new Set(['google_create_conversion_action', 'google_update_conversion_action', 'google_set_conversion_action_status', 'google_remove_conversion_action', 'google_upload_click_conversions', 'google_upload_call_conversions', 'google_upload_conversion_adjustments']);

/** Official v25 wire contracts: googleapis/googleapis@492a18f4, conversion action/upload services. */
export class GoogleConversionService {
  constructor(private readonly client: GoogleAdsRestClient) {}
  async context(accountId: string) {
    const account = normalizeCustomerId(accountId);
    const rows = await this.client.search(account, 'SELECT customer.resource_name, customer.id, customer.currency_code, customer.conversion_tracking_setting.google_ads_conversion_customer, customer.conversion_tracking_setting.conversion_tracking_id, customer.conversion_tracking_setting.cross_account_conversion_tracking_id, customer.conversion_tracking_setting.accepted_customer_data_terms, customer.conversion_tracking_setting.conversion_tracking_status, customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled FROM customer LIMIT 2', { maxRows: 2 });
    const customer = object(rows[0]?.customer), tracking = object(customer.conversionTrackingSetting);
    if (rows.length !== 1 || customer.id !== account || customer.resourceName !== `customers/${account}` || !currency.safeParse(customer.currencyCode).success) throw new AdportError('PROVIDER_ERROR', 'google: invalid conversion tracking customer identity');
    const owner = tracking.googleAdsConversionCustomer;
    if (owner !== undefined && owner !== '' && (typeof owner !== 'string' || !/^customers\/\d{10}$/.test(owner))) throw new AdportError('PROVIDER_ERROR', 'google: invalid conversion tracking owner');
    const context = { customer, conversion_customer: typeof owner === 'string' && owner ? owner : null };
    return { ...context, snapshot_hash: digest({ account, currency: customer.currencyCode, tracking }) };
  }
  private action(value: unknown, account: string, owner: string | null): Row {
    const action = object(value), resource = typeof action.resourceName === 'string' ? action.resourceName.match(/^customers\/(\d{10})\/conversionActions\/([1-9]\d*)$/) : null;
    if (!resource || action.id !== resource[2] || (resource[1] !== account && `customers/${resource[1]}` !== owner) || typeof action.name !== 'string' || typeof action.type !== 'string' || !['ENABLED', 'HIDDEN', 'REMOVED'].includes(String(action.status)) || (action.ownerCustomer !== undefined && action.ownerCustomer !== '' && !/^customers\/\d{10}$/.test(String(action.ownerCustomer)))) throw new AdportError('PROVIDER_ERROR', 'google: invalid conversion action identity or configuration');
    return action;
  }
  async list(input: { account_id: string; after_action_id?: string; limit: number; include_removed?: boolean }) {
    const account = normalizeCustomerId(input.account_id), context = await this.context(account);
    if (input.after_action_id) id.parse(input.after_action_id);
    const predicates = [...(!input.include_removed ? ["conversion_action.status != 'REMOVED'"] : []), ...(input.after_action_id ? [`conversion_action.id > ${input.after_action_id}`] : [])];
    const rows = await this.client.search(account, `SELECT ${actionFields} FROM conversion_action${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY conversion_action.id ASC LIMIT ${input.limit + 1}`, { maxRows: input.limit + 1 });
    const actions = rows.map(row => this.action(row.conversionAction, account, context.conversion_customer));
    if (actions.some((value, index) => BigInt(String(value.id)) <= BigInt(index ? String(actions[index - 1]!.id) : input.after_action_id ?? '0'))) throw new AdportError('PROVIDER_ERROR', 'google: conversion action continuation did not advance');
    const page = actions.slice(0, input.limit), truncated = actions.length > input.limit;
    return { context, actions: page, truncated, ...(truncated ? { next_cursor: String(page.at(-1)!.id) } : {}) };
  }
  async get(accountId: string, actionId: string) {
    const account = normalizeCustomerId(accountId); id.parse(actionId);
    const context = await this.context(account);
    const rows = await this.client.search(account, `SELECT ${actionFields} FROM conversion_action WHERE conversion_action.id = ${actionId} LIMIT 2`, { maxRows: 2 });
    if (rows.length !== 1) throw new AdportError('INVALID_INPUT', 'google: conversion action was not available in the selected account');
    const action = this.action(rows[0]!.conversionAction, account, context.conversion_customer);
    if (action.id !== actionId) throw new AdportError('PROVIDER_ERROR', 'google: conversion action ID mismatch');
    const { tagSnippets: _tags, attributionModelSettings, ...configuration } = action;
    const attribution = object(attributionModelSettings);
    return { action, context, editable: action.ownerCustomer === `customers/${account}` && String(action.resourceName).startsWith(`customers/${account}/`), snapshot_hash: digest({ context: context.snapshot_hash, ...configuration, attributionModel: attribution.attributionModel }) };
  }
  private async checked(account: string, input: z.infer<typeof statusAction> | z.infer<typeof updateAction> | z.infer<typeof removeAction>, editing = true) {
    const current = await this.get(account, input.conversion_action_id);
    if (current.snapshot_hash !== input.expected_action_hash) throw new AdportError('PENDING_MISMATCH', 'google: conversion action or tracking context changed; read it again before previewing');
    if (editing && !current.editable) throw new AdportError('INVALID_INPUT', 'google: this action is shared, system-owned or owned by another conversion customer; select its explicitly authorized owner to edit it');
    return current;
  }
  async plan(op: WriteOperation): Promise<GoogleConversionPlan> {
    const account = normalizeCustomerId(op.accountId);
    if (op.tool.startsWith('google_upload_')) return this.uploadPlan(op);
    if (op.tool === 'google_create_conversion_action') {
      const input = createAction.parse(op.payload), context = await this.context(account);
      if (context.snapshot_hash !== input.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'google: conversion tracking context changed; request a fresh preview');
      if (context.conversion_customer && context.conversion_customer !== `customers/${account}`) throw new AdportError('INVALID_INPUT', 'google: conversions are managed by another customer; select its explicitly authorized account to create an action');
      const { expected_context_hash: _hash, type, ...settings } = input;
      const create = { ...this.settings(settings).body, type, status: 'ENABLED' };
      return this.mutate(account, [{ create }], `Create Google conversion action "${input.name}"`, [`+ ${input.type} · ${input.category} · ${input.counting_type} · primary_for_goal=${input.primary_for_goal}.`, 'Creates configuration only; no conversion events, tag installation or campaign goal association.']);
    }
    if (op.tool === 'google_remove_conversion_action') {
      const input = removeAction.parse(op.payload), current = await this.checked(account, input);
      return this.mutate(account, [{ remove: current.action.resourceName }], `Remove Google conversion action "${current.action.name}"`, [`- ${current.action.resourceName}. Recording, reporting and bidding goals that use this action can be affected.`]);
    }
    const status = op.tool === 'google_set_conversion_action_status';
    if (!status && op.tool !== 'google_update_conversion_action') throw new AdportError('INVALID_INPUT', 'google: unsupported conversion operation');
    const input = status ? statusAction.parse(op.payload) : updateAction.parse(op.payload), current = await this.checked(account, input);
    if (current.action.status === 'REMOVED' && !status) throw new AdportError('INVALID_INPUT', 'google: this conversion action has been removed; use the status tool to request native re-enablement first');
    if ('status' in input && input.status === 'REMOVED') {
      const plan = this.mutate(account, [{ remove: current.action.resourceName }], `Remove Google conversion action "${current.action.name}"`, [`- ${current.action.resourceName}. Recording, reporting and bidding goals that use this action can be affected.`]);
      return { ...plan, fieldChanges: [{ field: 'status', before: String(current.action.status), after: 'REMOVED' }], notes: [...(plan.notes ?? []), 'REMOVED uses the native remove operation; writing REMOVED directly to the status field was rejected by the live API.'] };
    }
    const { conversion_action_id: _id, expected_action_hash: _hash, ...settings } = input;
    const { body, mask } = this.settings(settings), changes = mask.map(field => ({ field, before: JSON.stringify(this.path(current.action, field) ?? null), after: JSON.stringify(this.path(body, field) ?? null) }));
    const plan = this.mutate(account, [{ update: { resourceName: current.action.resourceName, ...body }, updateMask: mask.join(',') }], `Update Google conversion action "${current.action.name}"`, changes.map(value => `~ ${value.field}: ${value.before} → ${value.after}`));
    return { ...plan, fieldChanges: changes };
  }
  private settings(input: Row) {
    const body: Row = {}, mask: string[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      if (key === 'value_settings') {
        body.valueSettings = wire(value);
        for (const field of Object.keys(object(value))) mask.push(`value_settings.${field}`);
      } else if (key === 'attribution_model') {
        body.attributionModelSettings = { attributionModel: value }; mask.push('attribution_model_settings.attribution_model');
      } else {
        body[camel(key)] = /_days$|_seconds$/.test(key) ? String(value) : value; mask.push(key);
      }
    }
    return { body, mask };
  }
  private path(row: Row, path: string): unknown { return path.split('.').reduce<unknown>((value, key) => object(value)[camel(key)], row); }
  private mutate(account: string, operations: Row[], summary: string, changes: string[]): GoogleConversionPlan {
    return { summary, changes, coercions: [], budgetDeltas: [], notes: ['Conversion values use whole currency units, not budget micros. Goal classification, counting, attribution, windows and status changes can affect reporting and bidding.', 'primary_for_goal=false excludes ordinary goals but does not override a custom conversion goal. Omitted fields are preserved; action type and ownership are immutable here.'], execute: async validateOnly => {
      const result = await this.client.mutate(account, 'conversionActions', operations, { validateOnly });
      if (validateOnly) return [];
      const names = result.results?.map(value => value.resourceName);
      if (!names?.length || names.some(value => typeof value !== 'string' || !new RegExp(`^customers/${account}/conversionActions/[1-9]\\d*$`).test(value))) throw new AdportError('PROVIDER_ERROR', 'google: conversion mutation was not confirmed; inspect native state before retrying');
      return names as string[];
    } };
  }
  private async uploadPlan(op: WriteOperation): Promise<GoogleConversionPlan> {
    const kind = op.tool === 'google_upload_click_conversions' ? 'click' : op.tool === 'google_upload_call_conversions' ? 'call' : op.tool === 'google_upload_conversion_adjustments' ? 'adjustment' : undefined;
    if (!kind) throw new AdportError('INVALID_INPUT', 'google: unsupported conversion upload');
    const input = kind === 'click' ? clickUpload.parse(op.payload) : kind === 'call' ? callUpload.parse(op.payload) : adjustmentUpload.parse(op.payload);
    const account = normalizeCustomerId(op.accountId), current = await this.checked(account, input, false);
    const action = current.action, tracking = object(current.context.customer.conversionTrackingSetting);
    if (action.status !== 'ENABLED' || !current.context.conversion_customer || action.ownerCustomer !== current.context.conversion_customer) throw new AdportError('INVALID_INPUT', 'google: upload action must be enabled and owned by the verified conversion tracking customer');
    if ((kind === 'click' && action.type !== 'UPLOAD_CLICKS') || (kind === 'call' && action.type !== 'UPLOAD_CALLS')) throw new AdportError('INVALID_INPUT', 'google: conversion action type does not match this upload service');
    const source: Row[] = 'adjustments' in input ? input.adjustments : input.conversions;
    const records: Row[] = source.map(value => ({ ...object(wire(value)), conversionAction: action.resourceName }));
    const keys = source.map(value => kind === 'adjustment' ? `${value.adjustment_type}:${value.order_id ?? digest(value.gclid_date_time_pair)}:${value.adjustment_date_time}` : kind === 'call' ? `${value.caller_id}:${value.call_start_date_time}:${value.conversion_date_time}` : value.order_id ? `order:${value.order_id}` : `event:${value.gclid ?? value.wbraid ?? value.gbraid ?? digest(value.user_identifiers)}:${value.conversion_date_time}`);
    if (new Set(keys).size !== keys.length) throw new AdportError('INVALID_INPUT', 'google: duplicate conversion identities in this batch');
    if (source.some(value => Array.isArray(value.user_identifiers)) && tracking.acceptedCustomerDataTerms !== true) throw new AdportError('INVALID_INPUT', 'google: native customer-data terms are not accepted; no identifiers were uploaded and no terms were accepted');
    if (kind === 'click') {
      const external = object(action.attributionModelSettings).attributionModel === 'EXTERNAL';
      if (source.some(value => Boolean(value.external_attribution_data) !== external)) throw new AdportError('INVALID_INPUT', 'google: external attribution data must match the action attribution model');
    }
    const method = kind === 'click' ? 'uploadClickConversions' : kind === 'call' ? 'uploadCallConversions' : 'uploadConversionAdjustments';
    const batchHash = digest(records), count = records.length;
    let details: unknown, warnings: string[] = [];
    return { summary: `Upload ${count} Google ${kind} conversion record${count === 1 ? '' : 's'} to "${action.name}"`, changes: [`+ ${count} records to ${action.resourceName}; conversion owner ${action.ownerCustomer}.`, `Approved batch SHA-256: ${batchHash}. Values are whole currency units.`, ...(kind === 'adjustment' ? ['Restatements change recorded values; retractions remove recorded conversions; enhancements add matching identifiers. These can affect reporting and bidding.'] : ['These events can affect measured revenue, conversion counts and automated bidding.'])], coercions: [], budgetDeltas: [], notes: ['Native validate_only previews submit no events. Validation does not establish future attribution, matching success or eventual reporting.', 'Partial failures are evaluated per native row; unknown or failed rows are never retried automatically. Inspect row outcomes before any new upload.', 'Click imports use the legacy Google Ads endpoint, restricted for new adopters since June 2026. New integrations require the separate Data Manager API and OAuth scope.', 'Preview and audit summaries omit event identifiers; identical full arguments and the action/context hash remain bound to approval.'], resultDetails: () => details, resultWarnings: () => warnings, execute: async validateOnly => {
      let response: Row;
      try { response = await this.client.uploadConversions(account, method, records, validateOnly, 'job_id' in input ? input.job_id : undefined); }
      catch (error) {
        const failure = this.uploadErrors(object(object(error).details).error, count, kind);
        throw new AdportError('PROVIDER_ERROR', 'google: conversion request failed; no automatic retry. Check native diagnostics before reuploading.', { batch_sha256: batchHash, record_count: count, ...failure });
      }
      const failure = this.uploadErrors(response.partialFailureError, count, kind);
      if (validateOnly) {
        if (Number(object(response.partialFailureError).code ?? 0) !== 0 || failure.errors.length || failure.unmapped) throw new AdportError('PROVIDER_ERROR', 'google: conversion validation failed; no events were submitted', { batch_sha256: batchHash, ...failure });
        return [];
      }
      const results = Array.isArray(response.results) ? response.results : [];
      const rows = records.map((_value, index) => {
        const result = object(results[index]), failed = failure.errors.some(value => value.index === index);
        const expected = records[index]!;
        const identityFields = ['gclid', 'gbraid', 'wbraid', 'callerId', 'callStartDateTime', 'conversionDateTime', 'adjustmentDateTime', 'orderId', 'adjustmentType'];
        const matchesEcho = identityFields.every(key => {
          const requested = expected[key], returned = result[key];
          if (requested === undefined || returned === undefined) return true;
          if (key.endsWith('DateTime') && typeof requested === 'string' && typeof returned === 'string') return Date.parse(requested.replace(' ', 'T')) === Date.parse(returned.replace(' ', 'T'));
          return requested === returned;
        });
        const matched = !failure.unmapped && results.length <= count && result.conversionAction === action.resourceName && matchesEcho;
        return { index, status: matched && !failed ? 'CONFIRMED' : failed && !Object.keys(result).length ? 'FAILED' : 'UNKNOWN' };
      });
      const succeeded = rows.filter(value => value.status === 'CONFIRMED').length, failed = rows.filter(value => value.status === 'FAILED').length, unknown = count - succeeded - failed;
      const jobId = typeof response.jobId === 'string' && /^\d+$/.test(response.jobId) ? response.jobId : typeof response.jobId === 'number' && Number.isSafeInteger(response.jobId) && response.jobId >= 0 ? String(response.jobId) : undefined;
      const complete = succeeded === count && !failure.unmapped && results.length === count && !failure.errors.length;
      details = { status: complete ? 'COMPLETE' : 'PARTIAL_OR_UNCONFIRMED', batch_sha256: batchHash, record_count: count, confirmed_count: succeeded, failed_count: failed, unknown_count: unknown, rows, errors: failure.errors, ...(jobId ? { job_id: jobId } : {}), ...(failure.request_id ? { request_id: failure.request_id } : {}) };
      if (!succeeded) throw new AdportError('PROVIDER_ERROR', 'google: no conversion rows were confirmed. Inspect the returned row outcomes before retrying.', details);
      if (!complete) warnings = [`Only ${succeeded} of ${count} conversion rows were confirmed; ${failed} failed and ${unknown} remain unconfirmed. Inspect result.details and native diagnostics before uploading again.`];
      return [String(action.resourceName)];
    } };
  }
  private uploadErrors(value: unknown, count: number, kind: string) {
    const status = object(value), details = Array.isArray(status.details) ? status.details : [];
    const errors: Array<{ index?: number; codes: string[]; fields: string[] }> = [];
    let requestId: string | undefined, unmapped = false;
    for (const detail of details) {
      const item = object(detail);
      if (typeof item.requestId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(item.requestId)) requestId = item.requestId;
      for (const raw of Array.isArray(item.errors) ? item.errors : []) {
        const error = object(raw), path = object(error.location).fieldPathElements;
        const parts = Array.isArray(path) ? path.map(object) : [];
        const at = parts.find(part => part.fieldName === (kind === 'adjustment' ? 'conversionAdjustments' : 'conversions') || part.fieldName === 'conversion_adjustments');
        const index = typeof at?.index === 'number' && Number.isInteger(at.index) && at.index >= 0 && at.index < count ? at.index : undefined;
        if (index === undefined) unmapped = true;
        errors.push({ ...(index !== undefined ? { index } : {}), codes: Object.entries(object(error.errorCode)).filter(([key, item]) => /^[a-zA-Z]+Error$/.test(key) && typeof item === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(item)).map(([key, item]) => `${key}.${item}`), fields: parts.flatMap(part => typeof part.fieldName === 'string' && /^[a-zA-Z_]+$/.test(part.fieldName) ? [part.fieldName] : []) });
      }
    }
    if (Number(status.code ?? 0) !== 0 && !errors.length) unmapped = true;
    return { errors, unmapped, ...(requestId ? { request_id: requestId } : {}) };
  }
}

const removeAction = z.object(reference);
const contextView = z.object({ customer: z.record(z.string(), z.unknown()), conversion_customer: z.string().nullable(), snapshot_hash: hash });
const actionView = z.object({ action: z.record(z.string(), z.unknown()), context: contextView, editable: z.boolean(), snapshot_hash: hash });
export function googleConversionTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  const write = (tool: string, description: string, payload: z.ZodObject, kind: 'create' | 'update' | 'remove', additive = false) => guardedWriteTool({ name: tool, namespace: 'google', provider: 'google', kind, destructive: !additive, description, payload });
  return [
    defineTool({ name: 'google_conversion_tracking_context', namespace: 'google', description: 'Read the selected customer conversion tracking owner, currency, tracking status and customer-data terms flags. Returns snapshot_hash for configuration creation; never accepts terms or changes tracking ownership.', input: z.object({ account_id: z.string() }), output: contextView, annotations: { readOnly: true }, handler: input => provider.conversions.context(input.account_id) }),
    defineTool({ name: 'google_conversion_actions', namespace: 'google', description: 'List native conversion configuration available in the selected customer, including owner, type, status, goals, attribution, value settings and tag snippets. Continue next_cursor as after_action_id.', input: z.object({ account_id: z.string(), after_action_id: id.optional(), include_removed: z.boolean().default(false), limit: z.number().int().positive().max(200).default(50) }), output: z.object({ context: contextView, actions: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean(), next_cursor: id.optional() }), pagination: { cursorInput: 'after_action_id' }, annotations: { readOnly: true }, handler: input => provider.conversions.list(input) }),
    defineTool({ name: 'google_get_conversion_action', namespace: 'google', description: 'Read one available action and snapshot_hash, bound to its native owner and selected-customer tracking context. Shared/system-owned actions remain read-only. Tag snippets are returned as text and never installed.', input: z.object({ account_id: z.string(), conversion_action_id: id }), output: actionView, annotations: { readOnly: true }, handler: input => provider.conversions.get(input.account_id, input.conversion_action_id) }),
    write('google_create_conversion_action', 'Create an UPLOAD_CLICKS, UPLOAD_CALLS or WEBPAGE conversion configuration using expected_context_hash from tracking context. Explicit category/counting mode; secondary by default. Native validate_only preview; no events sent or tags installed.', createAction, 'create', true),
    write('google_update_conversion_action', 'Edit owned conversion configuration using expected_action_hash. Omitted fields and omitted nested value settings are preserved with exact update masks. Classification, primary goal, values, counting, windows and attribution can affect reporting and bidding.', updateAction, 'update'),
    write('google_set_conversion_action_status', 'Enable or remove an owned conversion action with expected_action_hash. REMOVED uses the native remove operation and can affect goals; re-enablement uses native ENABLED subject to type restrictions. HIDDEN is readable but excluded from writes after a live native denial.', statusAction, 'update'),
    write('google_remove_conversion_action', 'Remove an owned conversion action with expected_action_hash. Recording, reports and goals using the action can be affected. Native validate_only preview; no conversion events are submitted.', removeAction, 'remove'),
    write('google_upload_click_conversions', 'Upload 1–2000 captured click conversions or enhanced leads through the legacy Google Ads endpoint using expected_action_hash. Supports captured GCLID/GBRAID/WBRAID together, explicit consent and SHA-256 identifiers. Legacy access is restricted for new adopters; Data Manager is a separate API. Native validate_only preview; partial row outcomes are explicit.', clickUpload, 'create'),
    write('google_upload_call_conversions', 'Upload 1–2000 call conversions to an enabled UPLOAD_CALLS action with expected_action_hash. Requires actual E.164 caller ID, call start, later conversion time, value and currency. Native validate_only preview; row failures/uncertainty are reported without automatic retries.', callUpload, 'create'),
    write('google_upload_conversion_adjustments', 'Retract, restate or enhance 1–2000 existing conversions using expected_action_hash and their original order ID or supported GCLID/date-time pair. Restatements use the final total value; enhancements require order ID and separately hashed identifiers. Native validate_only preview; affects reporting/bidding and reports partial outcomes.', adjustmentUpload, 'update'),
  ];
}
