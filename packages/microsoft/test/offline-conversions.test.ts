import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { microsoftTools } from '../src/tools.js';
import { offlineAdjustments, offlineUpload } from '../src/offline-conversion-schemas.js';
import { offlineEvent, offlineFixture, OFFLINE_ACCOUNT as account, OFFLINE_NOW, type OfflineRow as Row } from './offline-conversion-fixture.js';

// Wire contracts: MicrosoftDocs/Advertising@5bde65c3 and BingAds REST Python SDK@4b6fb31c.
const upload = 'microsoft_upload_offline_conversions', adjust = 'microsoft_upload_offline_conversion_adjustments', guard = { forcePausedCreation: true };
const op = (payload: Row, tool = upload): WriteOperation => ({ provider: 'microsoft', accountId: account, tool, kind: tool === adjust ? 'update' : 'create', payload });
const dirs: string[] = [];
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse(OFFLINE_NOW)); });
afterEach(async () => { vi.restoreAllMocks();await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const records = [offlineEvent, { ...offlineEvent, microsoft_click_id: 'private-click-identity-2' }, { ...offlineEvent, microsoft_click_id: 'private-click-identity-3' }];

describe('Microsoft offline import and adjustment contracts', () => {
  it('defines both tools lazily with private inputs and the shared policy contract', () => {
    const defs = microsoftTools(new Proxy({} as never, { get() { throw new Error('Eager access'); } }));
    for (const [name, field] of [[upload, 'conversions'], [adjust, 'adjustments']]) {
      const def = defs.find(tool => tool.name === name)!;expect(def.catalog).toEqual({ category: 'measurement', exposure: 'specialist' });expect(def.sensitiveInputs).toEqual([field]);expect(def.annotations.readOnly).toBe(false);expect(def.description).toContain('IDENTICAL arguments');
    }
  });
  it('previews a native batch without sending it and omits identifiers from the structured review', async () => {
    const f = offlineFixture(), before = structuredClone(f.state), args = await f.args();
    const preview = await f.provider.previewWrite(op(args), guard);
    expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [], coercions: [], review: { provider: 'microsoft', title: 'Import offline conversions', fields: expect.arrayContaining([{ label: 'Records', after: 1 }]) } });
    expect(JSON.stringify(preview)).not.toContain(offlineEvent.microsoft_click_id);expect(JSON.stringify(preview)).not.toContain(offlineEvent.conversion_time);expect(f.writes()).toEqual([]);expect(f.state).toEqual(before);
  });
  it('sends exact scoped REST fields and whole-unit values once; records acceptance without inventing event IDs', async () => {
    const f = offlineFixture(), before = structuredClone(f.state), args = await f.args();
    const preview = await f.provider.previewWrite(op(args), guard), result = await f.provider.applyWrite(op(args), guard);
    expect(f.writes()).toHaveLength(1);expect(f.writes()[0]).toMatchObject({ method: 'POST', path: 'OfflineConversions/Apply', headers: { CustomerId: '9001', CustomerAccountId: account }, body: { OfflineConversions: [{ ConversionName: '<Owned offline goal>', MicrosoftClickId: offlineEvent.microsoft_click_id, ConversionTime: offlineEvent.conversion_time, ConversionValue: 12.34, ConversionCurrencyCode: 'EUR' }] } });
    expect(result).toMatchObject({ applied: true, resourceIds: ['100'], warnings: [], details: { status: 'ACCEPTED_FOR_PROCESSING', receipt_status: 'ALL_ACCEPTED', processed: false, record_count: 1, accepted_count: 1, failed_count: 0, unknown_count: 0, rows: [{ index: 0, status: 'ACCEPTED' }], next_tool: 'microsoft_offline_conversion_goal_report' } });
    expect(JSON.stringify(result)).not.toContain(offlineEvent.microsoft_click_id);expect(JSON.stringify(result)).not.toContain(offlineEvent.conversion_time);expect(JSON.stringify(preview)).toContain((result.details as Row).batch_sha256);expect(f.state).toEqual(before);
  });
  it('preserves omitted conversion values/currency and paused goal/disabled auto-tagging without coercion', async () => {
    const f = offlineFixture();f.state.auto = false;f.state.goal.Status = 'Paused';f.state.goal.Scope = 'Customer';
    const args = await f.args({ conversions: [{ microsoft_click_id: 'private-id', conversion_time: offlineEvent.conversion_time }] });
    const preview = await f.provider.previewWrite(op(args), guard);expect(preview.notes!.join(' ')).toMatch(/goal is Paused/);expect(preview.notes!.join(' ')).toMatch(/auto-tagging is disabled/);
    await f.provider.applyWrite(op(args), guard);expect(f.writes()[0]!.body.OfflineConversions[0]).toEqual({ ConversionName: '<Owned offline goal>', MicrosoftClickId: 'private-id', ConversionTime: offlineEvent.conversion_time });expect(f.state.auto).toBe(false);expect(f.state.goal.Status).toBe('Paused');
  });
  it('supports already enabled enhanced-only matching without echoing hashed identifiers', async () => {
    const f = offlineFixture(), event = { hashed_email_address: 'a'.repeat(64), hashed_phone_number: 'b'.repeat(64), conversion_time: offlineEvent.conversion_time }, args = await f.args({ conversions: [event] });
    const preview = await f.provider.previewWrite(op(args), guard);expect(JSON.stringify(preview)).not.toContain(event.hashed_email_address);expect(JSON.stringify(preview)).not.toContain(event.hashed_phone_number);
    await f.provider.applyWrite(op(args), guard);expect(f.writes()[0]!.body.OfflineConversions[0]).toEqual({ ConversionName: '<Owned offline goal>', HashedEmailAddress: event.hashed_email_address, HashedPhoneNumber: event.hashed_phone_number, ConversionTime: event.conversion_time });
  });
  it('requires the existing enhanced flag and never opts in, enables tracking or accepts terms', async () => {
    const f = offlineFixture();f.state.goal.IsEnhancedConversionsEnabled = false;const args = await f.args({ conversions: [{ hashed_email_address: 'a'.repeat(64), conversion_time: offlineEvent.conversion_time }] });
    await expect(f.provider.previewWrite(op(args), guard)).rejects.toThrow(/already enabled/);expect(f.writes()).toEqual([]);expect(f.state.goal.IsEnhancedConversionsEnabled).toBe(false);
  });
  it('binds external attribution to the verified native goal', async () => {
    const f = offlineFixture(), event = { ...offlineEvent, external_attribution_credit: 0.25, external_attribution_model: 'Approved CRM attribution' };
    await expect(f.provider.previewWrite(op(await f.args({ conversions: [event] })), guard)).rejects.toThrow(/externally attributed/);
    f.state.goal.IsExternallyAttributed = true;await f.provider.applyWrite(op(await f.args({ conversions: [event] })), guard);expect(f.writes()[0]!.body.OfflineConversions[0]).toMatchObject({ ExternalAttributionCredit: 0.25, ExternalAttributionModel: event.external_attribution_model });
  });
  it.each(['Name', 'Status', 'Scope', 'Revenue', 'IsExternallyAttributed', 'IsEnhancedConversionsEnabled', 'CountType'])('rejects stale %s before a native event request', async field => {
    const f = offlineFixture(), args = await f.args();f.state.goal[field] = field === 'Revenue' ? { Type: 'NoValue' } : 'changed';await expect(f.provider.previewWrite(op(args), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(f.writes()).toEqual([]);
  });
  it('rejects stale auto-tagging and unavailable accounts', async () => {
    const f = offlineFixture(), args = await f.args();f.state.auto = false;await expect(f.provider.previewWrite(op(args), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });f.state.available = false;await expect(f.provider.previewWrite(op(args), guard)).rejects.toThrow();expect(f.writes()).toEqual([]);
  });
  it.each(['provider', 'kind'])('rejects mismatched operation %s', async field => {
    const f = offlineFixture(), operation = op(await f.args());await expect(f.provider.offlineConversions.plan({ ...operation, [field]: field === 'provider' ? 'google' : 'remove' })).rejects.toThrow(/mismatch/);expect(f.writes()).toEqual([]);
  });
  it('keeps 100ns identities distinct while rejecting equivalent decimal timestamp duplicates', async () => {
    const f = offlineFixture(), first = { ...offlineEvent, conversion_time: '2026-11-05T10:00:00.1000000Z' };
    await expect(f.provider.previewWrite(op(await f.args({ conversions: [first, { ...first, conversion_time: '2026-11-05T10:00:00.1Z', conversion_value: 44 }] })), guard)).rejects.toThrow(/duplicate/);
    await f.provider.applyWrite(op(await f.args({ conversions: [first, { ...first, conversion_time: '2026-11-05T10:00:00.1000001Z' }] })), guard);expect(f.writes()[0]!.body.OfflineConversions.map((row: Row) => row.ConversionTime)).toEqual([first.conversion_time, '2026-11-05T10:00:00.1000001Z']);
  });
  it.each(['2026-11-07T00:00:00Z', '2026-07-01T00:00:00Z'])('rejects out-of-range conversion time %s', async time => {
    const f = offlineFixture();await expect(f.provider.previewWrite(op(await f.args({ conversions: [{ ...offlineEvent, conversion_time: time }] })), guard)).rejects.toThrow(/last90days/);expect(f.writes()).toEqual([]);
  });
  it('writes exact Restate/Retract bodies and preserves original conversion times and zero values', async () => {
    const f = offlineFixture(), args = await f.args();delete args.conversions;
    args.adjustments = [{ ...offlineEvent, conversion_value: undefined, conversion_currency_code: undefined, adjustment_type: 'Restate', adjustment_time: '2026-11-06T00:00:00Z', adjustment_value: 0, adjustment_currency_code: 'USD' }, { microsoft_click_id: 'other-private-click', conversion_time: offlineEvent.conversion_time, adjustment_time: '2026-11-06T00:00:00Z', adjustment_type: 'Retract' }];
    // Strict schemas intentionally reject irrelevant original value fields on adjustments.
    delete args.adjustments[0].conversion_value;delete args.adjustments[0].conversion_currency_code;
    const preview = await f.provider.previewWrite(op(args, adjust), guard);expect(preview.review?.fields).toContainEqual({ label: 'Adjustments', after: { restatements: 1, retractions: 1 } });
    await f.provider.applyWrite(op(args, adjust), guard);expect(f.writes()[0]).toMatchObject({ path: 'OfflineConversionAdjustments/Apply', method: 'POST', body: { OfflineConversionAdjustments: [{ ConversionName: '<Owned offline goal>', MicrosoftClickId: offlineEvent.microsoft_click_id, ConversionTime: offlineEvent.conversion_time, AdjustmentTime: '2026-11-06T00:00:00Z', AdjustmentType: 'Restate', AdjustmentValue: 0, AdjustmentCurrencyCode: 'USD' }, { ConversionName: '<Owned offline goal>', MicrosoftClickId: 'other-private-click', ConversionTime: offlineEvent.conversion_time, AdjustmentTime: '2026-11-06T00:00:00Z', AdjustmentType: 'Retract' }] } });expect(f.writes()).toHaveLength(1);
  });
  it.each(['2026-11-04T00:00:00Z', '2026-11-07T00:00:00Z'])('rejects adjustment time %s outside original-to-present interval', async adjustment_time => {
    const f = offlineFixture(), args = await f.args();delete args.conversions;args.adjustments = [{ microsoft_click_id: offlineEvent.microsoft_click_id, conversion_time: offlineEvent.conversion_time, adjustment_time, adjustment_type: 'Retract' }];await expect(f.provider.previewWrite(op(args, adjust), guard)).rejects.toThrow(/adjustment time/);expect(f.writes()).toEqual([]);
  });
  it('refuses two adjustments to the same original even when type/time differ', async () => {
    const f = offlineFixture(), args = await f.args();delete args.conversions;const row = { microsoft_click_id: 'private', conversion_time: offlineEvent.conversion_time, adjustment_time: '2026-11-06T00:00:00Z', adjustment_type: 'Retract' };args.adjustments = [row, { ...row, adjustment_time: '2026-11-06T01:00:00Z' }];await expect(f.provider.previewWrite(op(args, adjust), guard)).rejects.toThrow(/duplicate/);expect(f.writes()).toEqual([]);
  });
  it('requires identities, UTC precision, exact currencies and valid external credit without accepting raw fields', async () => {
    const f = offlineFixture(), args = await f.args();
    for (const event of [{ conversion_time: offlineEvent.conversion_time }, { ...offlineEvent, email: 'private@example.com' }, { ...offlineEvent, conversion_time: '2026-11-05T10:00:00+01:00' }, { ...offlineEvent, conversion_time: '2026-11-05T10:00Z' }, { ...offlineEvent, conversion_time: '2026-11-05T10:00:00.12345678Z' }, { ...offlineEvent, hashed_phone_number: '+49123456' }, { ...offlineEvent, external_attribution_credit: 0 }, { ...offlineEvent, external_attribution_credit: 1.01 }, { ...offlineEvent, conversion_currency_code: 'eur' }, { ...offlineEvent, ConversionName: 'Other goal' }]) expect(offlineUpload.safeParse({ ...args, conversions: [event] }).success).toBe(false);
    expect(offlineUpload.safeParse({ ...args, acknowledge_measurement_effects: false }).success).toBe(false);
    const conversion = { microsoft_click_id: 'x', conversion_time: offlineEvent.conversion_time, adjustment_time: '2026-11-06T00:00:00Z' };
    for (const row of [{ ...conversion, adjustment_type: 'Restate', adjustment_value: 3 }, { ...conversion, adjustment_type: 'Retract', adjustment_value: 0 }, { ...conversion, adjustment_type: 'Retract', adjustment_currency_code: 'EUR' }]) expect(offlineAdjustments.safeParse({ goal_id: args.goal_id, expected_goal_hash: args.expected_goal_hash, acknowledge_measurement_effects: true, adjustments: [row] }).success).toBe(false);
  });
  it('accepts the native1000-row bound and rejects1001 without splitting or retrying', async () => {
    const f = offlineFixture(), conversions = Array.from({ length: 1000 }, (_, n) => ({ ...offlineEvent, microsoft_click_id: `private-${n}` })), args = await f.args({ conversions });
    await f.provider.applyWrite(op(args), guard);expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.body.OfflineConversions).toHaveLength(1000);expect(offlineUpload.safeParse({ ...args, conversions: [...conversions, offlineEvent] }).success).toBe(false);
  });
  it('routes local generic collection writes to typed private upload tools', async () => {
    const f = offlineFixture();for (const resource of ['OfflineConversions', 'OfflineConversionAdjustments']) await expect(f.provider.previewWrite({ ...op({ resource, body: {} }), tool: 'microsoft_api_create' }, guard)).rejects.toThrow(/typed upload/);expect(f.writes()).toEqual([]);
  });
});

describe('sparse Microsoft offline receipts and private failures', () => {
  it('reports a completely rejected batch as failures, not acceptance or unknown success', async () => {
    const f = offlineFixture(call => call.path.endsWith('/Apply') ? { PartialErrors: [{ Index: 0, Code: 5001 }, { Index: 1, Code: 5001 }, { Index: 2, Code: 5002 }] } : undefined);
    await expect(f.provider.applyWrite(op(await f.args({ conversions: records })), guard)).rejects.toMatchObject({ details: { accepted_count: 0, failed_count: 3, unknown_count: 0, processed: false } });expect(f.writes()).toHaveLength(1);
  });
  it('maps zero-based sparse indexes, permits multiple errors per row and never echoes native messages', async () => {
    const secret = offlineEvent.microsoft_click_id, f = offlineFixture(call => call.path.endsWith('/Apply') ? { PartialErrors: [{ Index: 2, Code: 5011, Message: secret, Details: secret }, null, { Index: 0, Code: 5012, ErrorCode: secret }, { Index: 2, Code: 5013, FieldPath: secret }] } : undefined);
    const result = await f.provider.applyWrite(op(await f.args({ conversions: records })), guard);expect(result.details).toMatchObject({ status: 'ACCEPTED_FOR_PROCESSING', processed: false, receipt_status: 'PARTIAL', accepted_count: 1, failed_count: 2, unknown_count: 0, rows: [{ index: 0, status: 'FAILED' }, { index: 1, status: 'ACCEPTED' }, { index: 2, status: 'FAILED' }], errors: [{ index: 2, code: 5011 }, { index: 0, code: 5012 }, { index: 2, code: 5013 }] });expect(result.warnings![0]).toContain('1 of 3');expect(JSON.stringify(result)).not.toContain(secret);expect(f.writes()).toHaveLength(1);
  });
  it.each([{}, { PartialErrors: null }, { PartialErrors: [] }, { PartialErrors: [null] }])('accepts the documented optional/empty error list %j as a processing receipt', async response => {
    const f = offlineFixture(call => call.path.endsWith('/Apply') ? response : undefined);const result = await f.provider.applyWrite(op(await f.args()), guard);expect(result.details).toMatchObject({ accepted_count: 1, processed: false, receipt_verified: true });
  });
  it.each([{ PartialErrors: false }, { PartialErrors: [{ Index: 8, Code: 1 }] }, { PartialErrors: [{ Code: 1 }] }, { PartialErrors: [{ Index: 0, Code: '1' }] }, { Errors: [{ Code: 1 }] }, [], null])('does not certify success from malformed or unscoped receipt %j', async response => {
    const f = offlineFixture(call => call.path.endsWith('/Apply') ? Response.json(response) : undefined);await expect(f.provider.applyWrite(op(await f.args()), guard)).rejects.toMatchObject({ details: { accepted_count: 0, unknown_count: 1, processed: false } });expect(f.writes()).toHaveLength(1);
  });
  it('retains known failed rows while classifying the rest unknown on an unmapped native error', async () => {
    const f = offlineFixture(call => call.path.endsWith('/Apply') ? { PartialErrors: [{ Index: 2, Code: 10 }, { Index: 99, Code: 11 }] } : undefined);await expect(f.provider.applyWrite(op(await f.args({ conversions: records })), guard)).rejects.toMatchObject({ details: { accepted_count: 0, failed_count: 1, unknown_count: 2, unmapped_error_count: 1, rows: [{ index: 0, status: 'UNKNOWN' }, { index: 1, status: 'UNKNOWN' }, { index: 2, status: 'FAILED' }] } });
  });
  it.each(['http', 'accepted202', 'json', 'empty', 'transport'])('keeps %s outcomes unknown without private error content or retries', async mode => {
    const f = offlineFixture(call => { if (!call.path.endsWith('/Apply')) return;if (mode === 'transport') throw new Error(offlineEvent.microsoft_click_id);return new Response(mode === 'empty' ? '' : mode === 'json' ? offlineEvent.microsoft_click_id : JSON.stringify(mode === 'accepted202' ? { PartialErrors: [] } : { Message: offlineEvent.microsoft_click_id }), { status: mode === 'http' ? 400 : mode === 'accepted202' ? 202 : 200 }); });
    try { await f.provider.applyWrite(op(await f.args()), guard);throw new Error('Expected failure'); } catch (e) { expect(JSON.stringify(e)).not.toContain(offlineEvent.microsoft_click_id);expect(e).toMatchObject({ code: 'PROVIDER_ERROR', details: { accepted_count: 0, failed_count: 0, unknown_count: 1 } }); }expect(f.writes()).toHaveLength(1);
  });
  it('consumes exact approval once and keeps identifiers out of the append-only audit after an uncertain apply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microsoft-offline-'));dirs.push(dir);const audit = new AuditLog(join(dir, 'audit')), engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), audit), f = offlineFixture(call => call.path.endsWith('/Apply') ? new Response('private response '+offlineEvent.microsoft_click_id, { status: 500 }) : undefined), runtime = await createContext({ engine, providerModules: [{ provider: f.provider, tools: microsoftTools(f.provider) }] }), args = { ...await f.args(), account_id: account };
    const preview = await runtime.registry.call(upload, args, runtime.ctx) as Row;expect(f.writes()).toEqual([]);
    await expect(runtime.registry.call(upload, { ...args, conversions: [{ ...offlineEvent, conversion_value: 99 }], pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(f.writes()).toEqual([]);
    await expect(runtime.registry.call(upload, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ details: { approval_consumed: true, unknown_count: 1 } });
    await expect(runtime.registry.call(upload, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });expect(f.writes()).toHaveLength(1);expect(JSON.stringify(await audit.read())).not.toContain(offlineEvent.microsoft_click_id);expect(JSON.stringify(await audit.read())).toContain(preview.preview.review.fields.find((field: Row) => field.label === 'Batch SHA-256').after);
    const protectedEngine = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [account] }, new PendingStore(join(dir, 'protected-pending')), audit);await expect(protectedEngine.validate(f.provider, op(args))).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });expect(f.writes()).toHaveLength(1);
  });
  it('rechecks goal revenue before consuming an approval or submitting records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microsoft-offline-drift-'));dirs.push(dir);const engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), f = offlineFixture(), runtime = await createContext({ engine, providerModules: [{ provider: f.provider, tools: microsoftTools(f.provider) }] }), args = { ...await f.args(), account_id: account };
    const preview = await runtime.registry.call(upload, args, runtime.ctx) as Row;f.state.goal.Revenue.Value = 99;
    await expect(runtime.registry.call(upload, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(f.writes()).toEqual([]);
  });
});
