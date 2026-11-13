import { createContext, DEFAULT_POLICY, PolicyEngine, type PendingOperation, type WriteOperation } from '@adport/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_DATA_MANAGER_SCOPE, GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';

// Official Google Data Manager v1 wire contracts and offline/online guides checked
// 2026-11-04; googleapis/googleapis@492a18f4 ingestion, destination, event and diagnostics protos.
const selected = '1234567890', owner = '9999999999', login = '9876543210', actionId = '701';
const customer = { resourceName: `customers/${selected}`, id: selected, currencyCode: 'EUR', conversionTrackingSetting: { googleAdsConversionCustomer: `customers/${selected}`, acceptedCustomerDataTerms: true } };
const action = { resourceName: `customers/${selected}/conversionActions/${actionId}`, id: actionId, name: 'Conversion fixture', ownerCustomer: `customers/${selected}`, status: 'ENABLED', type: 'UPLOAD_CLICKS', category: 'PURCHASE' };
const event = { event_timestamp: '2026-10-20T12:30:00.123456789+02:00', event_source: 'WEB', ad_identifiers: { gclid: 'private-captured-gclid' }, transaction_id: 'private-transaction', currency: 'EUR', conversion_value: 0 };
const target = { operatingAccount: { accountType: 'GOOGLE_ADS', accountId: selected }, loginAccount: { accountType: 'GOOGLE_ADS', accountId: login }, productDestinationId: actionId };
const guard = { forcePausedCreation: true };
function fixture(scope: string | undefined = `https://www.googleapis.com/auth/adwords ${GOOGLE_DATA_MANAGER_SCOPE}`, refreshToken = 'fixture-refresh') {
  let currentCustomer: Record<string, unknown> = structuredClone(customer), currentAction: Record<string, unknown> = structuredClone(action);
  let response: (body: Record<string, unknown>, url: URL) => unknown = body => body.validateOnly ? {} : { requestId: 'native/request+id=' };
  let statusResponse: unknown = { requestStatusPerDestination: [{ destination: target, requestStatus: 'SUCCESS', eventsIngestionStatus: { recordCount: '1' } }] };
  const calls: Array<{ url: URL; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)), body = url.hostname === 'oauth2.googleapis.com' ? {} : JSON.parse(String(init.body ?? '{}'));
    calls.push({ url, init, body });
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token', expires_in: 3600, ...(scope !== undefined ? { scope } : {}) });
    if (url.hostname === 'googleads.googleapis.com') return Response.json({ results: String(body.query).includes(' FROM customer ') ? [{ customer: currentCustomer }] : [{ conversionAction: currentAction }] });
    const value = url.pathname.endsWith('events:ingest') ? response(body, url) : statusResponse;
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : Response.json(value);
  });
  const client = new GoogleAdsRestClient({ clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken, loginCustomerIds: { [selected]: login } }, 'v25', fetcher as typeof fetch);
  const provider = new GoogleAdsProvider(client);
  return { client, provider, calls, response(fn: typeof response) { response = fn; }, status(value: unknown) { statusResponse = value; }, customer(value: Record<string, unknown>) { currentCustomer = value; }, action(value: Record<string, unknown>) { currentAction = value; } };
}
const native = (f: ReturnType<typeof fixture>) => f.calls.filter(value => value.url.hostname === 'datamanager.googleapis.com');
async function operation(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}): Promise<WriteOperation> {
  const current = await f.provider.conversions.get(selected, actionId);
  return { tool: 'google_ingest_conversion_events', provider: 'google', accountId: selected, kind: 'create', payload: { conversion_action_id: actionId, expected_action_hash: current.snapshot_hash, events: [event], ...extra } };
}
async function accepted(f: ReturnType<typeof fixture>) { return (await f.provider.applyWrite(await operation(f), guard)).details as { resource_receipt: string }; }
afterEach(() => vi.restoreAllMocks());

describe('Google Data Manager conversions', () => {
  it('reports existing scopes without exposing or replacing credentials or claiming API enablement', async () => {
    const f = fixture(), result = await f.provider.dataManager.context(selected);
    expect(result).toMatchObject({ account_id: selected, login_account_id: login, required_scope: GOOGLE_DATA_MANAGER_SCOPE, scope_status: 'GRANTED', api_enablement: 'NOT_CHECKED' });
    expect(JSON.stringify(result)).not.toContain('fixture-token');
    expect(native(f)).toHaveLength(0);
    expect(f.calls.filter(value => value.url.hostname === 'oauth2.googleapis.com')).toHaveLength(1);
    const tools = googleTools(f.provider);
    expect(new Set(tools.map(value => value.name)).size).toBe(tools.length);
    expect(tools.find(value => value.name === 'google_ingest_conversion_events')!.annotations).toMatchObject({ readOnly: false, destructive: true });
  });
  it('never widens a missing OAuth scope and preserves UNKNOWN when the OAuth response omits it', async () => {
    const missing = fixture('https://www.googleapis.com/auth/adwords');
    expect(await missing.provider.dataManager.context(selected)).toMatchObject({ scope_status: 'MISSING' });
    await expect(missing.provider.previewWrite(await operation(missing), guard)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(native(missing)).toHaveLength(0);
    expect(new URLSearchParams(String(missing.calls[0]!.init.body)).has('scope')).toBe(false);
    const fetcher = vi.fn(async () => Response.json({ access_token: 'opaque', expires_in: 3600 }));
    const client = new GoogleAdsRestClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }, 'v25', fetcher as typeof fetch);
    expect(await client.dataManagerAccess()).toMatchObject({ scope_status: 'UNKNOWN' });
  });
  it('uses the separate v1 endpoint and JSON login/operating accounts with validateOnly and whole-currency zero values', async () => {
    const f = fixture(), op = await operation(f);
    const preview = await f.provider.previewWrite(op, guard), request = native(f)[0]!;
    expect(preview).toMatchObject({ serverValidated: true, budgetDeltas: [], coercions: [] });
    expect(request.url.href).toBe('https://datamanager.googleapis.com/v1/events:ingest');
    expect(request.init.method).toBe('POST'); expect(request.init.redirect).toBe('error'); expect(request.init.signal).toBeInstanceOf(AbortSignal);
    expect(request.init.headers).toEqual({ authorization: 'Bearer fixture-token', 'content-type': 'application/json' });
    expect(request.body).toEqual({ destinations: [target], events: [{ eventTimestamp: event.event_timestamp, eventSource: 'WEB', adIdentifiers: { gclid: event.ad_identifiers.gclid }, transactionId: event.transaction_id, currency: 'EUR', conversionValue: 0 }], validateOnly: true });
    expect(JSON.stringify(preview)).not.toContain(event.transaction_id); expect(JSON.stringify(preview)).not.toContain(event.ad_identifiers.gclid);
  });
  it('derives cross-account conversion routing from native ownership without accepting arbitrary destinations', async () => {
    const f = fixture(); f.customer({ ...customer, conversionTrackingSetting: { ...customer.conversionTrackingSetting, googleAdsConversionCustomer: `customers/${owner}` } });
    f.action({ ...action, resourceName: `customers/${owner}/conversionActions/${actionId}`, ownerCustomer: `customers/${owner}` });
    await f.provider.previewWrite(await operation(f), guard);
    expect(native(f)[0]!.body.destinations).toEqual([{ ...target, operatingAccount: { accountType: 'GOOGLE_ADS', accountId: owner } }]);
    expect(f.calls.filter(value => value.url.hostname === 'googleads.googleapis.com').every(value => value.url.pathname.includes(selected))).toBe(true);
    const tool = googleTools(f.provider).find(value => value.name === 'google_ingest_conversion_events')!;
    expect(tool.input.safeParse({ account_id: selected, ...(await operation(f)).payload, destinations: [{ operatingAccount: { accountId: owner } }] }).success).toBe(false);
  });
  it('requires enabled, matching native owner and a fresh action/context snapshot before either phase', async () => {
    const f = fixture(), op = await operation(f);
    f.action({ ...action, name: 'Changed' });
    await expect(f.provider.applyWrite(op, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    f.action({ ...action, ownerCustomer: `customers/${owner}` });
    await expect(f.provider.previewWrite(await operation(f), guard)).rejects.toThrow('verified conversion tracking customer');
    f.action({ ...action, status: 'REMOVED' });
    await expect(f.provider.previewWrite(await operation(f), guard)).rejects.toThrow('enabled');
    f.action({ ...action, type: 'UPLOAD_CALLS' });
    await expect(f.provider.previewWrite(await operation(f), guard)).rejects.toThrow('UPLOAD_CLICKS or WEBPAGE');
    expect(native(f)).toHaveLength(0);
  });
  it('requires the online transaction key and preserves optional online source while requiring offline source', async () => {
    const f = fixture();
    await expect(f.provider.previewWrite(await operation(f, { events: [{ ...event, event_source: undefined }] }), guard)).rejects.toThrow('offline events require');
    f.action({ ...action, type: 'WEBPAGE' });
    await expect(f.provider.previewWrite(await operation(f, { events: [{ ...event, transaction_id: undefined }] }), guard)).rejects.toThrow('WEBPAGE events require');
    await f.provider.previewWrite(await operation(f, { events: [{ ...event, event_source: undefined }] }), guard);
    expect((native(f)[0]!.body.events as any[])[0]).not.toHaveProperty('eventSource');
    await expect(f.provider.previewWrite(await operation(f, { events: [{ ...event, event_source: 'IN_STORE' }] }), guard)).rejects.toThrow('WEBPAGE events require');
  });
  it('preserves independent identifiers, nanoseconds, cart int64 quantities and zero prices without inventing consent', async () => {
    const f = fixture(), record = { ...event, ad_identifiers: { gclid: 'g', gbraid: 'b', wbraid: 'w', session_attributes: 'captured-session', landing_page_device_info: { user_agent: 'captured-agent', ip_address: '2001:db8::1' } }, event_device_info: { ip_address: '192.0.2.1' }, cart_data: { merchant_id: '9007199254740993', merchant_feed_label: 'DE', items: [{ item_id: 'sku', merchant_product_id: '9007199254740994', quantity: '9007199254740993', unit_price: 0 }] }, custom_variables: [{ variable: 'source', value: 'captured' }], user_properties: { customer_type: 'NEW', customer_value_bucket: 'HIGH' } };
    await f.provider.previewWrite(await operation(f, { events: [record] }), guard);
    const row = (native(f)[0]!.body.events as any[])[0];
    expect(row).toMatchObject({ eventTimestamp: event.event_timestamp, adIdentifiers: { gclid: 'g', gbraid: 'b', wbraid: 'w', sessionAttributes: 'captured-session', landingPageDeviceInfo: { ipAddress: '2001:db8::1' } }, cartData: { merchantId: '9007199254740993', items: [{ quantity: '9007199254740993', unitPrice: 0 }] } });
    expect(row).not.toHaveProperty('consent'); expect(native(f)[0]!.body).not.toHaveProperty('encoding');
  });
  it('encodes only pre-hashed identifiers as HEX with explicit request consent and native accepted terms', async () => {
    const f = fixture(), user_data = { user_identifiers: [{ email_address: 'A'.repeat(64) }, { phone_number: 'b'.repeat(64) }, { address: { given_name: 'c'.repeat(64), family_name: 'd'.repeat(64), region_code: 'DE', postal_code: '10115' } }] };
    const op = await operation(f, { consent: { ad_user_data: 'CONSENT_GRANTED', ad_personalization: 'CONSENT_DENIED' }, events: [{ ...event, user_data }] });
    await f.provider.previewWrite(op, guard);
    expect(native(f)[0]!.body).toMatchObject({ encoding: 'HEX', consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED' }, events: [{ userData: { userIdentifiers: [{ emailAddress: 'A'.repeat(64) }, { phoneNumber: 'b'.repeat(64) }, { address: { givenName: 'c'.repeat(64), regionCode: 'DE' } }] } }] });
    f.customer({ ...customer, conversionTrackingSetting: { ...customer.conversionTrackingSetting, acceptedCustomerDataTerms: false } });
    await expect(f.provider.previewWrite(await operation(f, { consent: { ad_user_data: 'CONSENT_GRANTED' }, events: [{ ...event, user_data }] }), guard)).rejects.toThrow('terms are not accepted');
    expect(native(f)).toHaveLength(1);
  });
  it.each([
    { ...event, event_timestamp: '2026-02-30T12:30:00Z' },
    { ...event, event_timestamp: '2026-10-20T12:30:00' },
    { ...event, event_timestamp: '2026-10-20T12:30:00.1234567890Z' },
    { ...event, ad_identifiers: undefined },
    { ...event, user_data: { user_identifiers: [{ email_address: 'raw@example.com' }] }, consent: { ad_user_data: 'CONSENT_GRANTED' } },
    { ...event, user_data: { user_identifiers: [{ email_address: 'a'.repeat(64), phone_number: 'b'.repeat(64) }] }, consent: { ad_user_data: 'CONSENT_GRANTED' } },
    { ...event, user_data: { user_identifiers: [{ email_address: 'a'.repeat(64) }] }, consent: { ad_personalization: 'CONSENT_GRANTED' } },
    { ...event, destination_references: ['foreign'] },
  ])('rejects ambiguous or invalid event fields at the registry boundary: %j', async record => {
    const f = fixture(), tool = googleTools(f.provider).find(value => value.name === 'google_ingest_conversion_events')!;
    expect(tool.input.safeParse({ account_id: selected, conversion_action_id: actionId, expected_action_hash: 'a'.repeat(64), consent: { ad_user_data: 'CONSENT_GRANTED' }, events: [record] }).success).toBe(false);
    expect(native(f)).toHaveLength(0);
  });
  it('rejects duplicate transaction identities rather than silently sending adjustments in one batch', async () => {
    const f = fixture();
    await expect(f.provider.previewWrite(await operation(f, { events: [event, { ...event, conversion_value: 100 }] }), guard)).rejects.toThrow('duplicate event identities');
    expect(native(f)).toHaveLength(0);
  });
  it('shows native optional-field warnings in preview and apply without echoing identifiers or descriptions', async () => {
    const f = fixture(); f.response(body => ({ ...(body.validateOnly ? {} : { requestId: 'native-request' }), fieldWarnings: [{ reason: 'WARNING_REASON_GENERIC', field: 'events[0].customVariables[0]', description: `private echo ${event.transaction_id}` }] }));
    const op = await operation(f), preview = await f.provider.previewWrite(op, guard), result = await f.provider.applyWrite(op, guard);
    expect(preview.notes).toContain('Data Manager WARNING_REASON_GENERIC at events[0].customVariables[0]; optional input may be ignored.');
    expect(result.warnings).toEqual(['Data Manager WARNING_REASON_GENERIC at events[0].customVariables[0]; optional input may be ignored.']);
    expect(JSON.stringify({ preview, result })).not.toContain(event.transaction_id);
    expect(result).toMatchObject({ details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, event_count: 1, next_tool: 'google_conversion_request_status', recommended_wait_seconds: 1800 } });
  });
  it('retains native error reasons and safe field paths while stripping sensitive messages/metadata', async () => {
    const f = fixture(); f.response(() => Response.json({ error: { code: 403, status: 'PERMISSION_DENIED', message: event.transaction_id, details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', metadata: { private: event.ad_identifiers.gclid } }, { fieldViolations: [{ field: 'events[0].userData', description: event.transaction_id }, { field: `events[${event.transaction_id}]` }] }] } }, { status: 403 }));
    let error: unknown; try { await f.provider.previewWrite(await operation(f), guard); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', details: { http_status: 403, status: 'PERMISSION_DENIED', reasons: ['ACCESS_TOKEN_SCOPE_INSUFFICIENT'], fields: ['events[0].userData'] } });
    expect(JSON.stringify(error)).not.toContain(event.transaction_id); expect(JSON.stringify(error)).not.toContain(event.ad_identifiers.gclid); expect(native(f)).toHaveLength(1);
  });
  it('never retries ambiguous network failures or treats an absent request ID as confirmed acceptance', async () => {
    const f = fixture(); f.response(() => new Error(`private ${event.transaction_id}`));
    await expect(f.provider.applyWrite(await operation(f), guard)).rejects.toThrow('not confirmed'); expect(native(f)).toHaveLength(1);
    const noId = fixture(); noId.response(() => ({}));
    await expect(noId.provider.applyWrite(await operation(noId), guard)).rejects.toThrow('acceptance was not confirmed'); expect(native(noId)).toHaveLength(1);
  });
  it('uses an escaped requestId query, no body or Ads headers, and verifies receipt/destination before reporting success', async () => {
    const f = fixture(), acceptedResult = await accepted(f), result = await f.provider.dataManager.status(selected, acceptedResult.resource_receipt), request = native(f)[1]!;
    expect(request.url.pathname).toBe('/v1/requestStatus:retrieve'); expect(request.url.searchParams.get('requestId')).toBe('native/request+id=');
    expect(request.init.method).toBe('GET'); expect(request.init.body).toBeUndefined(); expect(request.init.headers).not.toHaveProperty('login-customer-id');
    expect(result).toMatchObject({ status: 'SUCCESS', terminal: true, counts_match: true, record_count: '1', errors: [], warnings: [] });
    expect(result).not.toHaveProperty('successful_count');
  });
  it('rejects unsigned, altered, cross-account, expired or other-credential receipts before a status API call', async () => {
    const f = fixture(), result = await accepted(f), size = native(f).length;
    await expect(f.provider.dataManager.status(selected, 'native-request')).rejects.toThrow('invalid Data Manager receipt');
    await expect(f.provider.dataManager.status(selected, `${result.resource_receipt.slice(0, -1)}!`)).rejects.toThrow('invalid Data Manager receipt');
    await expect(f.provider.dataManager.status(owner, result.resource_receipt)).rejects.toThrow('mismatched account');
    await expect(fixture(undefined, 'different-credential').provider.dataManager.status(selected, result.resource_receipt)).rejects.toThrow('invalid Data Manager receipt');
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 86400_000);
    await expect(f.provider.dataManager.status(selected, result.resource_receipt)).rejects.toThrow('expired'); expect(native(f)).toHaveLength(size);
  });
  it('rechecks tracking ownership and rejects foreign status destinations without returning their data', async () => {
    const f = fixture(), result = await accepted(f);
    f.status({ requestStatusPerDestination: [{ destination: { ...target, operatingAccount: { accountType: 'GOOGLE_ADS', accountId: owner } }, requestStatus: 'SUCCESS', eventsIngestionStatus: { recordCount: '1' } }] });
    await expect(f.provider.dataManager.status(selected, result.resource_receipt)).rejects.toThrow('outside the approved');
    f.customer({ ...customer, conversionTrackingSetting: { ...customer.conversionTrackingSetting, googleAdsConversionCustomer: `customers/${owner}` } });
    await expect(f.provider.dataManager.status(selected, result.resource_receipt)).rejects.toThrow('owner changed'); expect(native(f)).toHaveLength(2);
  });
  it.each(['PROCESSING', 'PARTIAL_SUCCESS', 'FAILED', 'SUCCESS'])('preserves native %s status and overlapping diagnostic counts', async state => {
    const f = fixture(), result = await accepted(f), row = { destination: target, requestStatus: state, ...(state === 'PROCESSING' ? {} : { eventsIngestionStatus: { recordCount: '1' }, ...(state === 'SUCCESS' ? {} : { errorInfo: { errorCounts: [{ reason: 'PROCESSING_ERROR_REASON_INVALID_GCLID', recordCount: '1' }] } }), warningInfo: { warningCounts: [{ reason: 'PROCESSING_WARNING_REASON_USER_IDENTIFIER_DECRYPTION_ERROR', recordCount: '1' }] } }) };
    f.status({ requestStatusPerDestination: [row] });
    const status = await f.provider.dataManager.status(selected, result.resource_receipt);
    expect(status).toMatchObject({ status: state, terminal: state !== 'PROCESSING' });
    expect(status).not.toHaveProperty('successful_count'); expect(status).not.toHaveProperty('failed_count');
  });
  it.each([{}, { requestStatusPerDestination: [] }, { requestStatusPerDestination: [{ destination: target, requestStatus: 'SUCCESS' }] }, { requestStatusPerDestination: [{ destination: target, requestStatus: 'SUCCESS', eventsIngestionStatus: { recordCount: '9007199254740993' } }] }])('keeps missing or inconsistent processing evidence UNKNOWN: %j', async response => {
    const f = fixture(), result = await accepted(f); f.status(response);
    expect(await f.provider.dataManager.status(selected, result.resource_receipt)).toMatchObject({ status: 'UNKNOWN', terminal: false });
  });
  it('enforces exact policy arguments, one-use approval and read-only authorization for all adapters', async () => {
    const f = fixture(), pending = new Map<string, PendingOperation>(), audits: unknown[] = [];
    const engine = new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(value) { pending.set(value.id, value); }, async get(key) { return pending.get(key); }, async delete(key) { pending.delete(key); }, async consume(id: string, expectedHash: string) { const value = pending.get(id); return !!value && value.opHash === expectedHash && Date.parse(value.expiresAt) > Date.now() && pending.delete(id); } }, { async append(value) { audits.push(value); } });
    const runtime = await createContext({ engine, providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] }), op = await operation(f), args = { account_id: selected, ...op.payload };
    const preview = await runtime.registry.call(op.tool, args, runtime.ctx) as { pending_operation_id: string };
    expect(native(f).every(value => value.body.validateOnly === true)).toBe(true);
    await expect(runtime.registry.call(op.tool, { ...args, events: [{ ...event, conversion_value: 100 }], pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    const result = await runtime.registry.call(op.tool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    expect(runtime.registry.get(op.tool).output!.safeParse(result).success).toBe(true);
    await expect(runtime.registry.call(op.tool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });
    expect(native(f).filter(value => value.body.validateOnly === false)).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(event.transaction_id); expect(JSON.stringify(audits)).not.toContain('resource_receipt');
    const denied = await createContext({ engine, providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }], authorizeToolCall: async tool => { if (!tool.annotations?.readOnly) throw new Error('read only'); } });
    await expect(denied.registry.call(op.tool, args, denied.ctx)).rejects.toThrow('read only');
  });
});
