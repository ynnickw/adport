import { createContext, DEFAULT_POLICY, PolicyEngine, type PendingOperation, type WriteOperation } from '@adport/core';
import { describe, expect, it, vi } from 'vitest';
import { GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';

// Wire contracts: googleapis/googleapis@492a18f4, Google Ads v25 conversion action,
// conversion upload and conversion adjustment services; live field metadata checked 2026-11-04.
const account = '1234567890', actionId = '701', resource = `customers/${account}/conversionActions/${actionId}`, guard = { forcePausedCreation: true };
const customer = { resourceName: `customers/${account}`, id: account, currencyCode: 'EUR', conversionTrackingSetting: { googleAdsConversionCustomer: `customers/${account}`, acceptedCustomerDataTerms: true, conversionTrackingStatus: 'CONVERSION_TRACKING_MANAGED_BY_SELF' } };
const action = { resourceName: resource, id: actionId, name: 'Offline leads', ownerCustomer: `customers/${account}`, status: 'ENABLED', type: 'UPLOAD_CLICKS', category: 'IMPORTED_LEAD', primaryForGoal: false, countingType: 'ONE_PER_CLICK', valueSettings: { defaultValue: 1, defaultCurrencyCode: 'EUR', alwaysUseDefaultValue: false }, attributionModelSettings: { attributionModel: 'GOOGLE_ADS_LAST_CLICK', dataDrivenModelStatus: 'AVAILABLE' } };
const when = '2026-10-20 12:30:00+02:00', later = '2026-10-21 12:30:00+02:00';
const click = { gclid: 'private-captured-click', order_id: 'private-order-1', conversion_date_time: when, conversion_value: 2.5, currency_code: 'EUR' };
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'google', accountId: account, kind, payload });
function fixture() {
  let currentCustomer: Record<string, unknown> = structuredClone(customer), currentAction: Record<string, unknown> = structuredClone(action);
  let respond: ((path: string, body: Record<string, unknown>) => unknown) | undefined;
  const calls: Array<{ url: URL; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'test-token', expires_in: 3600 });
    const body = JSON.parse(String(init.body ?? '{}')); calls.push({ url, init, body });
    const override = respond?.(url.pathname, body);
    if (override !== undefined) return override instanceof Response ? override : Response.json(override);
    if (url.pathname.endsWith('/googleAds:search')) return Response.json({ results: String(body.query).includes(' FROM customer ') ? [{ customer: currentCustomer }] : [{ conversionAction: currentAction }] });
    if (url.pathname.endsWith('/conversionActions:mutate')) return Response.json(body.validateOnly ? {} : { results: [{ resourceName: resource }] });
    const key = body.conversionAdjustments ? 'conversionAdjustments' : 'conversions';
    return Response.json(body.validateOnly ? {} : { results: (body[key] as Array<Record<string, unknown>>).map(value => ({ conversionAction: value.conversionAction, conversionDateTime: value.conversionDateTime, adjustmentDateTime: value.adjustmentDateTime })), jobId: '9223372036854775806' });
  });
  return { provider: new GoogleAdsProvider(new GoogleAdsRestClient({ clientId: 'test-client', clientSecret: 'test-secret', refreshToken: 'test-refresh', loginCustomerIds: { [account]: '9876543210' } }, 'v25', fetcher as typeof fetch)), calls, setCustomer(value: Record<string, unknown>) { currentCustomer = value; }, setAction(value: Record<string, unknown>) { currentAction = value; }, respond(fn: typeof respond) { respond = fn; } };
}
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(value => !value.url.pathname.endsWith('/googleAds:search'));
async function upload(f: ReturnType<typeof fixture>, tool = 'google_upload_click_conversions', extra: Record<string, unknown> = {}) {
  const current = await f.provider.conversions.get(account, actionId);
  return op(tool, { conversion_action_id: actionId, expected_action_hash: current.snapshot_hash, conversions: [click], ...extra }, 'create');
}

describe('Google conversion management', () => {
  it('defines every named tool once and exposes structured context/action outputs', async () => {
    const f = fixture(), tools = googleTools(f.provider);
    expect(new Set(tools.map(value => value.name)).size).toBe(tools.length);
    const context = await f.provider.conversions.context(account);
    expect(tools.find(value => value.name === 'google_conversion_tracking_context')!.output!.safeParse(context).success).toBe(true);
    expect(tools.find(value => value.name === 'google_get_conversion_action')!.output!.safeParse(await f.provider.conversions.get(account, actionId)).success).toBe(true);
    const queries = f.calls.map(value => String(value.body.query));
    expect(queries.some(value => value.includes('customer.conversion_tracking_setting FROM'))).toBe(false);
    expect(queries.some(value => value.includes('conversion_action.value_settings,') || value.includes('conversion_action.attribution_model_settings,'))).toBe(false);
  });
  it('binds ownership to native owner_customer as well as the resource namespace', async () => {
    const f = fixture(); f.setAction({ ...action, ownerCustomer: 'customers/9999999999' });
    const current = await f.provider.conversions.get(account, actionId);
    expect(current.editable).toBe(false);
    await expect(f.provider.previewWrite(op('google_update_conversion_action', { conversion_action_id: actionId, expected_action_hash: current.snapshot_hash, name: 'No' }), guard)).rejects.toThrow('shared, system-owned');
    await expect(f.provider.previewWrite(await upload(f), guard)).rejects.toThrow('verified conversion tracking customer');
    expect(writes(f)).toHaveLength(0);
  });
  it('reads available manager-owned actions without silently redirecting configuration mutations to that manager', async () => {
    const f = fixture(); f.setCustomer({ ...customer, conversionTrackingSetting: { ...customer.conversionTrackingSetting, googleAdsConversionCustomer: 'customers/9999999999' } });
    f.setAction({ ...action, resourceName: `customers/9999999999/conversionActions/${actionId}`, ownerCustomer: 'customers/9999999999' });
    const current = await f.provider.conversions.get(account, actionId);
    expect(current.editable).toBe(false);
    const context = await f.provider.conversions.context(account);
    await expect(f.provider.previewWrite(op('google_create_conversion_action', { expected_context_hash: context.snapshot_hash, name: 'No', type: 'UPLOAD_CLICKS', category: 'DEFAULT', counting_type: 'ONE_PER_CLICK' }, 'create'), guard)).rejects.toThrow('managed by another customer');
    await f.provider.previewWrite(await upload(f), guard);
    expect(writes(f)[0]!.url.pathname).toBe(`/v25/customers/${account}:uploadClickConversions`);
    expect((writes(f)[0]!.body.conversions as any[])[0].conversionAction).toBe(`customers/9999999999/conversionActions/${actionId}`);
    expect(f.calls.every(value => value.url.pathname.includes(account))).toBe(true);
  });
  it('creates secondary configuration with native validateOnly and preserves whole-currency values/int64 fields', async () => {
    const f = fixture(), context = await f.provider.conversions.context(account);
    const operation = op('google_create_conversion_action', { expected_context_hash: context.snapshot_hash, name: 'QA import', type: 'UPLOAD_CLICKS', category: 'PURCHASE', counting_type: 'MANY_PER_CLICK', click_through_lookback_window_days: 30, value_settings: { default_value: 2.5, default_currency_code: 'EUR', always_use_default_value: false } }, 'create');
    expect(await f.provider.previewWrite(operation, guard)).toMatchObject({ serverValidated: true, budgetDeltas: [], coercions: [] });
    const request = writes(f)[0]!;
    expect(request.url.pathname).toBe(`/v25/customers/${account}/conversionActions:mutate`);
    expect(request.body).toEqual({ operations: [{ create: { name: 'QA import', category: 'PURCHASE', countingType: 'MANY_PER_CLICK', primaryForGoal: false, clickThroughLookbackWindowDays: '30', valueSettings: { defaultValue: 2.5, defaultCurrencyCode: 'EUR', alwaysUseDefaultValue: false }, type: 'UPLOAD_CLICKS', status: 'ENABLED' } }], validateOnly: true, partialFailure: false });
    expect(request.init.headers).toMatchObject({ authorization: 'Bearer test-token', 'login-customer-id': '9876543210' });
    expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [resource] });
    expect(writes(f).at(-1)!.body.validateOnly).toBe(false);
  });
  it('updates exact nested masks and rejects configuration/context drift before mutation', async () => {
    const f = fixture(), current = await f.provider.conversions.get(account, actionId), operation = op('google_update_conversion_action', { conversion_action_id: actionId, expected_action_hash: current.snapshot_hash, value_settings: { default_value: 0 }, primary_for_goal: true });
    expect((await f.provider.previewWrite(operation, guard)).fieldChanges).toEqual(expect.arrayContaining([{ field: 'value_settings.default_value', before: '1', after: '0' }, { field: 'primary_for_goal', before: 'false', after: 'true' }]));
    const mutation = (writes(f)[0]!.body.operations as Array<Record<string, unknown>>)[0]!;
    expect(mutation.update).toEqual({ resourceName: resource, valueSettings: { defaultValue: 0 }, primaryForGoal: true });
    expect(String(mutation.updateMask).split(',').sort()).toEqual(['primary_for_goal', 'value_settings.default_value']);
    f.setAction({ ...action, name: 'Changed' });
    await expect(f.provider.applyWrite(operation, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(writes(f)).toHaveLength(1);
  });
  it('keeps data-driven model readiness and tag text outside the action configuration hash', async () => {
    const f = fixture(), before = await f.provider.conversions.get(account, actionId);
    f.setAction({ ...action, tagSnippets: [{ eventSnippet: '<script>never run</script>' }], attributionModelSettings: { ...action.attributionModelSettings, dataDrivenModelStatus: 'STALE' } });
    expect((await f.provider.conversions.get(account, actionId)).snapshot_hash).toBe(before.snapshot_hash);
  });
  it('uses native status and removal operations with their own validated snapshots', async () => {
    const f = fixture(), current = await f.provider.conversions.get(account, actionId);
    await f.provider.previewWrite(op('google_set_conversion_action_status', { conversion_action_id: actionId, expected_action_hash: current.snapshot_hash, status: 'REMOVED' }), guard);
    expect(writes(f)[0]!.body.operations).toEqual([{ remove: resource }]);
    await f.provider.previewWrite(op('google_remove_conversion_action', { conversion_action_id: actionId, expected_action_hash: current.snapshot_hash }, 'remove'), guard);
    expect(writes(f)[1]!.body.operations).toEqual([{ remove: resource }]);
    expect(writes(f).every(value => value.body.validateOnly === true)).toBe(true);
    const tool = googleTools(f.provider).find(value => value.name === 'google_set_conversion_action_status')!;
    expect(tool.input.safeParse({ account_id: account, conversion_action_id: actionId, expected_action_hash: current.snapshot_hash, status: 'HIDDEN' }).success).toBe(false);
    f.setAction({ ...action, status: 'REMOVED' });
    const removed = await f.provider.conversions.get(account, actionId);
    await f.provider.previewWrite(op('google_set_conversion_action_status', { conversion_action_id: actionId, expected_action_hash: removed.snapshot_hash, status: 'ENABLED' }), guard);
    expect(writes(f).at(-1)!.body.operations).toEqual([{ update: { resourceName: resource, status: 'ENABLED' }, updateMask: 'status' }]);
  });
  it('orders large IDs without number coercion and rejects foreign or nonadvancing native pages', async () => {
    const f = fixture(); f.respond((path, body) => path.endsWith('/googleAds:search') && String(body.query).includes(' FROM conversion_action ') ? { results: [{ conversionAction: { ...action, id: '9007199254740993', resourceName: `customers/${account}/conversionActions/9007199254740993` } }, { conversionAction: { ...action, id: '9007199254740994', resourceName: `customers/${account}/conversionActions/9007199254740994` } }] } : undefined);
    expect(await f.provider.conversions.list({ account_id: account, limit: 1, after_action_id: '9007199254740992' })).toMatchObject({ truncated: true, next_cursor: '9007199254740993' });
    await expect(f.provider.conversions.list({ account_id: account, limit: 1, after_action_id: '9007199254740993' })).rejects.toThrow('did not advance');
  });
  it('uploads captured click identifiers together and never converts values to budget micros or invents consent', async () => {
    const f = fixture(), operation = await upload(f, undefined, { conversions: [{ ...click, gbraid: 'captured-gbraid', wbraid: 'captured-wbraid', consent: { ad_user_data: 'DENIED' } }], job_id: 42 });
    await f.provider.previewWrite(operation, guard);
    expect(writes(f)[0]!.body).toEqual({ conversions: [{ gclid: click.gclid, orderId: click.order_id, conversionDateTime: when, conversionValue: 2.5, currencyCode: 'EUR', gbraid: 'captured-gbraid', wbraid: 'captured-wbraid', consent: { adUserData: 'DENIED' }, conversionAction: resource }], partialFailure: true, validateOnly: true, jobId: 42 });
    const result = await f.provider.applyWrite(operation, guard);
    expect(result).toMatchObject({ resourceIds: [resource], details: { status: 'COMPLETE', confirmed_count: 1, job_id: '9223372036854775806' }, warnings: [] });
    expect(JSON.stringify(result)).not.toContain(click.gclid); expect(JSON.stringify(result)).not.toContain(click.order_id);
  });
  it.each([
    { ...click, user_identifiers: [{ hashed_email: 'raw@example.com' }], consent: { ad_user_data: 'GRANTED' } },
    { ...click, user_identifiers: [{ hashed_email: 'a'.repeat(64), hashed_phone_number: 'b'.repeat(64) }], consent: { ad_user_data: 'GRANTED' } },
    { ...click, user_identifiers: [{ hashed_email: 'a'.repeat(64) }], consent: { ad_user_data: 'DENIED' } },
    { ...click, conversion_date_time: '2026-02-30 12:30:00+02:00' },
    { ...click, conversion_date_time: '2026-10-20 12:30:00' },
    { ...click, gclid: undefined, wbraid: 'captured', user_identifiers: [{ hashed_email: 'a'.repeat(64) }], consent: { ad_user_data: 'GRANTED' } },
  ])('rejects invalid/ambiguous identifiers, consent or timestamps before a provider request', async record => {
    const f = fixture(), tool = googleTools(f.provider).find(value => value.name === 'google_upload_click_conversions')!;
    expect(tool.input.safeParse({ account_id: account, conversion_action_id: actionId, expected_action_hash: 'a'.repeat(64), conversions: [record] }).success).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it('requires accepted native customer-data terms for hashed identifiers and rejects duplicate conversion keys', async () => {
    const f = fixture(); f.setCustomer({ ...customer, conversionTrackingSetting: { ...customer.conversionTrackingSetting, acceptedCustomerDataTerms: false } });
    await expect(f.provider.previewWrite(await upload(f, undefined, { conversions: [{ ...click, user_identifiers: [{ hashed_email: 'a'.repeat(64) }], consent: { ad_user_data: 'GRANTED' } }] }), guard)).rejects.toThrow('terms are not accepted');
    await expect(f.provider.previewWrite(await upload(f, undefined, { conversions: [click, click] }), guard)).rejects.toThrow('duplicate conversion');
    expect(writes(f)).toHaveLength(0);
  });
  it('validates call ownership/type and preserves E.164 and the two independent timestamps on the native wire', async () => {
    const f = fixture(); f.setAction({ ...action, type: 'UPLOAD_CALLS' });
    const operation = await upload(f, 'google_upload_call_conversions', { conversions: [{ caller_id: '+16502531234', call_start_date_time: when, conversion_date_time: later, conversion_value: 0, currency_code: 'USD' }] });
    await f.provider.previewWrite(operation, guard);
    expect(writes(f)[0]!.url.pathname).toBe(`/v25/customers/${account}:uploadCallConversions`);
    expect(writes(f)[0]!.body.conversions).toEqual([{ callerId: '+16502531234', callStartDateTime: when, conversionDateTime: later, conversionValue: 0, currencyCode: 'USD', conversionAction: resource }]);
    expect(writes(f)[0]!.body).not.toHaveProperty('jobId');
    await expect(f.provider.previewWrite(await upload(f), guard)).rejects.toThrow('type does not match');
  });
  it('sends restated final values and exact retraction/enhancement oneofs without original event identifiers in summaries', async () => {
    const f = fixture(), operation = await upload(f, 'google_upload_conversion_adjustments', { adjustments: [
      { adjustment_type: 'RESTATEMENT', order_id: 'original-order', adjustment_date_time: later, restatement_value: { adjusted_value: 1.25, currency_code: 'EUR' } },
      { adjustment_type: 'RETRACTION', gclid_date_time_pair: { gclid: click.gclid, conversion_date_time: when }, adjustment_date_time: later },
      { adjustment_type: 'ENHANCEMENT', order_id: 'enhanced-order', adjustment_date_time: later, user_identifiers: [{ hashed_email: 'a'.repeat(64), user_identifier_source: 'FIRST_PARTY' }] },
    ], conversions: undefined });
    const preview = await f.provider.previewWrite(operation, guard), request = writes(f)[0]!;
    expect(request.url.pathname).toBe(`/v25/customers/${account}:uploadConversionAdjustments`);
    expect(request.body.conversionAdjustments).toEqual([
      { adjustmentType: 'RESTATEMENT', orderId: 'original-order', adjustmentDateTime: later, restatementValue: { adjustedValue: 1.25, currencyCode: 'EUR' }, conversionAction: resource },
      { adjustmentType: 'RETRACTION', gclidDateTimePair: { gclid: click.gclid, conversionDateTime: when }, adjustmentDateTime: later, conversionAction: resource },
      { adjustmentType: 'ENHANCEMENT', orderId: 'enhanced-order', adjustmentDateTime: later, userIdentifiers: [{ hashedEmail: 'a'.repeat(64), userIdentifierSource: 'FIRST_PARTY' }], conversionAction: resource },
    ]);
    expect(JSON.stringify(preview)).not.toContain(click.gclid); expect(JSON.stringify(preview)).not.toContain('original-order');
  });
  it('handles HTTP-200 partial errors during native validation without issuing an approval token', async () => {
    const f = fixture(), operation = await upload(f);
    f.respond((path) => path.endsWith(':uploadClickConversions') ? { partialFailureError: { code: 3, message: `private ${click.gclid}`, details: [{ errors: [{ errorCode: { conversionUploadError: 'INVALID_GCLID' }, message: click.gclid, location: { fieldPathElements: [{ fieldName: 'conversions', index: 0 }, { fieldName: 'gclid' }] } }], requestId: 'native-request' }] } } : undefined);
    let error: unknown; try { await f.provider.previewWrite(operation, guard); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', details: { errors: [{ index: 0, codes: ['conversionUploadError.INVALID_GCLID'], fields: ['conversions', 'gclid'] }], request_id: 'native-request' } });
    expect(JSON.stringify(error)).not.toContain(click.gclid);
    expect(writes(f)).toHaveLength(1); expect(writes(f)[0]!.body.validateOnly).toBe(true);
  });
  it('reports mixed confirmed/failed/unknown rows without claiming all applied or returning sensitive native echoes', async () => {
    const f = fixture(), operation = await upload(f, undefined, { conversions: [click, { ...click, order_id: 'private-order-2' }, { ...click, order_id: 'private-order-3' }] });
    f.respond(path => path.endsWith(':uploadClickConversions') ? { results: [{ conversionAction: resource, gclid: click.gclid }, {}, {}], partialFailureError: { code: 3, details: [{ errors: [{ errorCode: { conversionUploadError: 'DUPLICATE_CLICK_CONVERSION_IN_REQUEST' }, location: { fieldPathElements: [{ fieldName: 'conversions', index: 1 }] } }] }] }, jobId: '9007199254740993' } : undefined);
    const result = await f.provider.applyWrite(operation, guard);
    expect(result).toMatchObject({ applied: true, resourceIds: [resource], details: { status: 'PARTIAL_OR_UNCONFIRMED', confirmed_count: 1, failed_count: 1, unknown_count: 1, rows: [{ index: 0, status: 'CONFIRMED' }, { index: 1, status: 'FAILED' }, { index: 2, status: 'UNKNOWN' }] }, warnings: [expect.stringContaining('Only 1 of 3')] });
    expect(JSON.stringify(result)).not.toContain(click.gclid); expect(writes(f)).toHaveLength(1);
  });
  it('preserves uncertainty for empty or foreign acknowledgements and never retries a failed request', async () => {
    const f = fixture(), operation = await upload(f);
    f.respond(path => path.endsWith(':uploadClickConversions') ? { results: [{ conversionAction: 'customers/9999999999/conversionActions/999' }] } : undefined);
    await expect(f.provider.applyWrite(operation, guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { confirmed_count: 0, unknown_count: 1 } });
    f.respond(path => path.endsWith(':uploadClickConversions') ? Response.json({ error: { code: 403, message: `private ${click.gclid}`, details: [{ errors: [{ errorCode: { notAllowlistedError: 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE' } }], requestId: 'native-request' }] } }, { status: 403 }) : undefined);
    let error: unknown; try { await f.provider.applyWrite(operation, guard); } catch (caught) { error = caught; }
    expect(JSON.stringify(error)).not.toContain(click.gclid);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', details: { errors: [{ codes: ['notAllowlistedError.CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE'] }] } });
    expect(writes(f)).toHaveLength(2);
  });
  it('does not confirm a mismatched native identity or an unmapped batch error', async () => {
    const f = fixture(), operation = await upload(f);
    f.respond(path => path.endsWith(':uploadClickConversions') ? { results: [{ conversionAction: resource, gclid: 'different-captured-click' }] } : undefined);
    await expect(f.provider.applyWrite(operation, guard)).rejects.toMatchObject({ details: { confirmed_count: 0, unknown_count: 1 } });
    f.respond(path => path.endsWith(':uploadClickConversions') ? { results: [{ conversionAction: resource }], partialFailureError: { code: 3, details: [{ errors: [{ errorCode: { conversionUploadError: 'INVALID_CONVERSION_ACTION' } }] }] } } : undefined);
    await expect(f.provider.applyWrite(operation, guard)).rejects.toMatchObject({ details: { confirmed_count: 0, unknown_count: 1 } });
    expect(writes(f)).toHaveLength(2);
  });
  it('keeps uploads behind the shared policy gate and exposes partial warnings through its output schema', async () => {
    const f = fixture(), pending = new Map<string, PendingOperation>();
    const engine = new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(value) { pending.set(value.id, value); }, async get(key) { return pending.get(key); }, async delete(key) { pending.delete(key); }, async consume(id: string, expectedHash: string) { const value = pending.get(id); return !!value && value.opHash === expectedHash && Date.parse(value.expiresAt) > Date.now() && pending.delete(id); } }, { async append() {} });
    const runtime = await createContext({ engine, providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    const operation = await upload(f), args = { account_id: account, ...operation.payload };
    const preview = await runtime.registry.call(operation.tool, args, runtime.ctx) as { pending_operation_id: string };
    expect(writes(f).every(value => value.body.validateOnly)).toBe(true);
    await expect(runtime.registry.call(operation.tool, { ...args, conversions: [{ ...click, conversion_value: 100 }], pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    const result = await runtime.registry.call(operation.tool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    expect(runtime.registry.get(operation.tool).output!.safeParse(result).success).toBe(true);
    expect(writes(f).filter(value => value.body.validateOnly === false)).toHaveLength(1);
  });
});
