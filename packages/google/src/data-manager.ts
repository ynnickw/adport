import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { GoogleAdsRestClient, isDataManagerFieldPath, normalizeCustomerId } from './client.js';
import { GoogleConversionService, type GoogleConversionPlan } from './conversions.js';
import type { GoogleAdsProvider } from './provider.js';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const id = z.string().regex(/^[1-9]\d*$/), hash = z.string().regex(/^[a-f0-9]{64}$/), opaque = z.string().min(1).max(4096);
const identifierHash = z.string().regex(/^[a-fA-F0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)) && (value.match(/\.(\d+)/)?.[1]?.length ?? 0) <= 9, 'Use a real RFC3339 timestamp with at most nanosecond precision');
const consent = z.object({ ad_user_data: z.enum(['CONSENT_GRANTED', 'CONSENT_DENIED']).optional(), ad_personalization: z.enum(['CONSENT_GRANTED', 'CONSENT_DENIED']).optional() }).strict();
const device = z.object({ user_agent: opaque.optional(), ip_address: z.union([z.ipv4(), z.ipv6()]).optional(), category: opaque.optional(), language_code: z.string().regex(/^[a-z]{2}$/).optional(), screen_height: z.number().int().nonnegative().max(2147483647).optional(), screen_width: z.number().int().nonnegative().max(2147483647).optional(), operating_system: opaque.optional(), operating_system_version: opaque.optional(), model: opaque.optional(), brand: opaque.optional(), browser: opaque.optional(), browser_version: opaque.optional() }).strict();
const identifier = z.union([
  z.object({ email_address: identifierHash }).strict(),
  z.object({ phone_number: identifierHash }).strict(),
  z.object({ address: z.object({ given_name: identifierHash, family_name: identifierHash, region_code: z.string().regex(/^[A-Z]{2}$/), postal_code: z.string().min(1).max(256) }).strict() }).strict(),
]);
const variable = z.object({ variable: z.string().min(1).max(256), value: z.string().max(4096) }).strict();
const event = z.object({
  event_timestamp: timestamp, last_updated_timestamp: timestamp.optional(), transaction_id: opaque.optional(),
  event_source: z.enum(['WEB', 'APP', 'IN_STORE', 'PHONE', 'MESSAGE', 'OTHER']).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(), conversion_value: z.number().finite().optional(), conversion_count: z.number().finite().nonnegative().optional(),
  user_data: z.object({ user_identifiers: z.array(identifier).min(1).max(10) }).strict().optional(), user_id: opaque.optional(), consent: consent.optional(),
  ad_identifiers: z.object({ gclid: opaque.optional(), gbraid: opaque.optional(), wbraid: opaque.optional(), session_attributes: z.string().min(1).max(65536).optional(), landing_page_device_info: device.optional() }).strict().optional(),
  event_device_info: device.optional(),
  cart_data: z.object({ merchant_id: id.optional(), merchant_feed_label: opaque.optional(), merchant_feed_language_code: z.string().regex(/^[a-z]{2}$/).optional(), transaction_discount: z.number().finite().optional(), coupon_codes: z.array(opaque).max(100).optional(), items: z.array(z.object({ item_id: opaque, merchant_product_id: opaque, quantity: z.string().regex(/^[1-9]\d*$/).refine(value => BigInt(value) <= 9223372036854775807n, 'Quantity exceeds int64'), unit_price: z.number().finite(), conversion_value: z.number().finite().optional(), custom_variables: z.array(variable).max(100).optional() }).strict()).min(1).max(1000) }).strict().optional(),
  custom_variables: z.array(variable).max(100).optional(),
  experimental_fields: z.array(z.object({ field: z.string().min(1).max(256), value: z.string().max(65536) }).strict()).max(100).optional(),
  user_properties: z.object({ customer_type: z.enum(['NEW', 'RETURNING', 'REENGAGED']).optional(), customer_value_bucket: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional() }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  const ad = value.ad_identifiers;
  if (!value.user_data && !ad?.gclid && !ad?.gbraid && !ad?.wbraid && !ad?.session_attributes && !ad?.landing_page_device_info?.ip_address && !value.event_device_info?.ip_address) ctx.addIssue({ code: 'custom', message: 'Supply captured click/session identifiers, an event or landing IP address, or hashed user data' });
});
const ingest = z.object({ conversion_action_id: id, expected_action_hash: hash, events: z.array(event).min(1).max(2000), consent: consent.optional() }).strict().superRefine((value, ctx) => {
  value.events.forEach((record, index) => {
    // A user-level consent object replaces request-level consent, including omitted fields.
    if (record.user_data && (record.consent ?? value.consent)?.ad_user_data !== 'CONSENT_GRANTED') ctx.addIssue({ code: 'custom', path: ['events', index, 'consent'], message: 'Hashed user data requires explicit CONSENT_GRANTED ad_user_data; never infer consent' });
  });
});
const account = z.string().regex(/^\d{10}$/), productAccount = z.object({ accountType: z.literal('GOOGLE_ADS'), accountId: account }).strict();
const destination = z.object({ operatingAccount: productAccount, loginAccount: productAccount, productDestinationId: id }).strict();
const receipt = z.object({ kind: z.literal('google_conversion_ingestion_v1'), account_id: account, destination, request_id: z.string().min(1).max(512).regex(/^[^\x00-\x20\x7f]+$/), batch_sha256: hash, event_count: z.number().int().min(1).max(2000), expires_at: z.number().int().positive().safe() }).strict();
const receiptInput = z.string().min(1).max(4096);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function wire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wire);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase()), wire(item)]));
  return value;
}
function warnings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return ['Data Manager returned unrecognized optional-field warnings; inspect diagnostics before relying on all supplied fields.'];
  return value.slice(0, 100).map(item => {
    const warning = object(item), reason = typeof warning.reason === 'string' && /^WARNING_REASON_[A-Z0-9_]{1,100}$/.test(warning.reason) ? warning.reason : 'WARNING_REASON_UNKNOWN';
    const field = isDataManagerFieldPath(warning.field) ? ` at ${warning.field}` : '';
    return `Data Manager ${reason}${field}; optional input may be ignored.`;
  }).concat(value.length > 100 ? [`${value.length - 100} more field warnings were returned.`] : []);
}
const count = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
function diagnosticCounts(value: unknown, key: 'errorCounts' | 'warningCounts') {
  const rows = object(value)[key];
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new AdportError('PROVIDER_ERROR', 'google: malformed Data Manager diagnostic counts');
  return rows.map(item => {
    const row = object(item), total = count(row.recordCount ?? '0');
    if (!total || typeof row.reason !== 'string' || !/^PROCESSING_(?:ERROR|WARNING)_[A-Z0-9_]{1,160}$/.test(row.reason)) throw new AdportError('PROVIDER_ERROR', 'google: malformed Data Manager diagnostic reason/count');
    return { reason: row.reason, record_count: total };
  });
}

/** Official Data Manager v1 contracts: googleapis/googleapis@492a18f4; guides checked 2026-11-04. */
export class GoogleDataManagerService {
  constructor(private readonly client: GoogleAdsRestClient, private readonly conversions: GoogleConversionService) {}

  async context(accountId: string) {
    const selected = normalizeCustomerId(accountId), tracking = await this.conversions.context(selected), access = await this.client.dataManagerAccess();
    return { account_id: selected, conversion_context: tracking, login_account_id: this.client.dataManagerLoginAccount(selected), ...access, api_enablement: 'NOT_CHECKED', note: 'This read checks the existing OAuth response, not API enablement or event eligibility. UNKNOWN means the OAuth server omitted scopes. Enable Data Manager API and explicitly authorize its separate scope before ingestion; no permissions or terms are changed.' };
  }

  async plan(op: WriteOperation): Promise<GoogleConversionPlan> {
    if (op.tool !== 'google_ingest_conversion_events') throw new AdportError('INVALID_INPUT', 'google: unsupported Data Manager mutation');
    const input = ingest.parse(op.payload), selected = normalizeCustomerId(op.accountId), current = await this.conversions.get(selected, input.conversion_action_id), action = current.action;
    if (current.snapshot_hash !== input.expected_action_hash) throw new AdportError('PENDING_MISMATCH', 'google: conversion action or tracking context changed; read it again before ingestion');
    if (action.status !== 'ENABLED' || !current.context.conversion_customer || action.ownerCustomer !== current.context.conversion_customer || !['UPLOAD_CLICKS', 'WEBPAGE'].includes(String(action.type))) throw new AdportError('INVALID_INPUT', 'google: Data Manager requires an enabled UPLOAD_CLICKS or WEBPAGE action owned by the verified conversion tracking customer');
    if (input.events.some(value => action.type === 'UPLOAD_CLICKS' ? !value.event_source : !value.transaction_id || (value.event_source !== undefined && !['WEB', 'APP'].includes(value.event_source)))) throw new AdportError('INVALID_INPUT', 'google: offline events require event_source; WEBPAGE events require transaction_id and, if supplied, WEB or APP event_source');
    if (input.events.some(value => value.user_data) && object(current.context.customer.conversionTrackingSetting).acceptedCustomerDataTerms !== true) throw new AdportError('INVALID_INPUT', 'google: native customer-data terms are not accepted; no user identifiers were uploaded and no terms were accepted');
    const keys = input.events.map(value => value.transaction_id ? `transaction:${value.transaction_id}` : digest(value));
    if (new Set(keys).size !== keys.length) throw new AdportError('INVALID_INPUT', 'google: duplicate event identities in this batch; repeated transaction IDs may adjust prior conversions');
    const target = destination.parse({ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: current.context.conversion_customer.slice('customers/'.length) }, loginAccount: { accountType: 'GOOGLE_ADS', accountId: this.client.dataManagerLoginAccount(selected) }, productDestinationId: input.conversion_action_id });
    const body = { destinations: [target], events: wire(input.events), ...(input.consent ? { consent: wire(input.consent) } : {}), ...(input.events.some(value => value.user_data) ? { encoding: 'HEX' } : {}) };
    const batchHash = digest(body), notes = ['Preview uses native validateOnly=true and ingests no events. It checks initial validation only; later matching, attribution and processing can still fail.', 'Apply accepts a request for asynchronous processing. Use its signed receipt with google_conversion_request_status after the provider-recommended 30 minutes; acceptance is not proof of processed conversions.', 'Repeated native transaction IDs may adjust previous events. Event data can affect conversion reporting and automated bidding. Values are whole currency units, not budget micros.', 'Preview and audit summaries omit event/user identifiers. The complete payload, destination and snapshot remain bound to the approval token. No automatic retry, permission expansion or terms acceptance.'];
    let details: unknown, resultWarnings: string[] = [];
    return { summary: `Ingest ${input.events.length} Google conversion event${input.events.length === 1 ? '' : 's'} with Data Manager`, changes: [`+ ${input.events.length} ${action.type} events to conversion action ${input.conversion_action_id}; operating owner ${target.operatingAccount.accountId}; login ${target.loginAccount.accountId}; selected account ${selected}.`, `Approved batch SHA-256: ${batchHash}. Processing is asynchronous.`], notes, coercions: [], budgetDeltas: [], resultDetails: () => details, resultWarnings: () => resultWarnings, execute: async validateOnly => {
      const result = await this.client.dataManagerRequest('ingest', { ...body, validateOnly });
      resultWarnings = warnings(result.fieldWarnings);
      if (validateOnly) { notes.push(...resultWarnings); return []; }
      const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86400;
      const bound = receipt.safeParse({ kind: 'google_conversion_ingestion_v1', account_id: selected, destination: target, request_id: result.requestId, batch_sha256: batchHash, event_count: input.events.length, expires_at: expiresAt });
      if (!bound.success) throw new AdportError('PROVIDER_ERROR', 'google: ingestion acceptance was not confirmed by a valid request ID; do not retry automatically', { batch_sha256: batchHash, event_count: input.events.length });
      details = { status: 'ACCEPTED_FOR_PROCESSING', processed: false, request_id: bound.data.request_id, batch_sha256: batchHash, event_count: input.events.length, resource_receipt: this.client.dataManagerReceipt(bound.data), receipt_expires_at: new Date(expiresAt * 1000).toISOString(), next_tool: 'google_conversion_request_status', recommended_wait_seconds: 1800, note: 'Only request acceptance is confirmed. Inspect status and diagnostics; do not resend this batch automatically.' };
      return [String(action.resourceName)];
    } };
  }

  async status(accountId: string, resourceReceipt: string) {
    const selected = normalizeCustomerId(accountId), bound = receipt.safeParse(this.client.verifyDataManagerReceipt(resourceReceipt)), now = Math.floor(Date.now() / 1000);
    if (!bound.success || bound.data.account_id !== selected || bound.data.expires_at <= now || bound.data.expires_at > now + 7 * 86400) throw new AdportError('INVALID_INPUT', 'google: expired or mismatched account ingestion receipt');
    const tracking = await this.conversions.context(selected);
    if (tracking.conversion_customer !== `customers/${bound.data.destination.operatingAccount.accountId}`) throw new AdportError('PENDING_MISMATCH', 'google: conversion tracking owner changed since ingestion; status was not requested');
    const result = await this.client.dataManagerRequest('status', { requestId: bound.data.request_id }), rows = result.requestStatusPerDestination;
    if (rows === undefined || (Array.isArray(rows) && rows.length === 0)) return { request_id: bound.data.request_id, batch_sha256: bound.data.batch_sha256, expected_event_count: bound.data.event_count, status: 'UNKNOWN', terminal: false, note: 'No destination status is available yet. This is not success; wait before checking again. Do not resend events.' };
    if (!Array.isArray(rows) || rows.length !== 1) throw new AdportError('PROVIDER_ERROR', 'google: Data Manager status destination count differs from the approved request');
    const row = object(rows[0]), target = object(row.destination), expected = bound.data.destination;
    const matches = (value: unknown, wanted: z.infer<typeof productAccount>) => { const got = object(value); return got.accountId === wanted.accountId && (got.accountType === 'GOOGLE_ADS' || (got.accountType === undefined && got.product === 'GOOGLE_ADS')) && (got.product === undefined || got.product === 'GOOGLE_ADS'); };
    if (!matches(target.operatingAccount, expected.operatingAccount) || target.productDestinationId !== expected.productDestinationId || (target.loginAccount !== undefined && !matches(target.loginAccount, expected.loginAccount)) || target.linkedAccount !== undefined) throw new AdportError('PROVIDER_ERROR', 'google: Data Manager returned a destination outside the approved ingestion receipt');
    const state = typeof row.requestStatus === 'string' && ['SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'PROCESSING', 'REQUEST_STATUS_UNKNOWN'].includes(row.requestStatus) ? row.requestStatus : 'UNKNOWN';
    const terminal = ['SUCCESS', 'PARTIAL_SUCCESS', 'FAILED'].includes(state), total = count(object(row.eventsIngestionStatus).recordCount), errors = diagnosticCounts(row.errorInfo, 'errorCounts'), fieldWarnings = diagnosticCounts(row.warningInfo, 'warningCounts');
    if (['audienceMembersIngestionStatus', 'audienceMembersRemovalStatus', 'removeAllAudienceMembersStatus'].some(key => row[key] !== undefined)) throw new AdportError('PROVIDER_ERROR', 'google: non-event Data Manager status returned for an event receipt');
    const expectedCount = String(bound.data.event_count), consistent = !terminal || (total === expectedCount && [...errors, ...fieldWarnings].every(value => BigInt(value.record_count) <= BigInt(expectedCount)) && (state !== 'SUCCESS' || !errors.some(value => BigInt(value.record_count) > 0n)));
    return { request_id: bound.data.request_id, batch_sha256: bound.data.batch_sha256, expected_event_count: bound.data.event_count, status: consistent ? state : 'UNKNOWN', native_status: state, terminal: terminal && consistent, ...(total !== undefined ? { record_count: total } : {}), counts_match: terminal ? consistent : null, errors, warnings: fieldWarnings, note: consistent ? 'record_count includes successful and failed records. Error and warning reasons can overlap; do not subtract their counts to invent a successful count. SUCCESS may still have warnings.' : 'Native processed-record count is missing or differs from the approved batch; do not assume completion or resend automatically.' };
  }
}

export function googleDataManagerTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'google_data_manager_context', namespace: 'google', description: 'Read the verified conversion owner, configured login account and existing OAuth Data Manager scope status. Does not change grants, enable APIs, accept terms or upload events.', input: z.object({ account_id: z.string() }), annotations: { readOnly: true }, handler: input => provider.dataManager.context(input.account_id) }),
    guardedWriteTool({ name: 'google_ingest_conversion_events', namespace: 'google', provider: 'google', kind: 'create', payload: ingest, description: 'Ingest 1–2000 offline UPLOAD_CLICKS or multi-source WEBPAGE conversion events with Data Manager v1. Requires its separate OAuth scope/API enablement and an action snapshot. Native validateOnly preview; apply returns asynchronous acceptance and an account-bound status receipt. Hashed user data is HEX with explicit consent. No automatic retry.' }),
    defineTool({ name: 'google_conversion_request_status', namespace: 'google', description: 'Read Data Manager processing status and error/warning counts using the signed receipt from this account’s approved ingestion. Native request IDs alone do not authorize this account-less endpoint. Wait about 30 minutes after acceptance; do not resubmit a processing batch.', input: z.object({ account_id: z.string(), resource_receipt: receiptInput }), annotations: { readOnly: true }, handler: input => provider.dataManager.status(input.account_id, input.resource_receipt) }),
  ];
}
