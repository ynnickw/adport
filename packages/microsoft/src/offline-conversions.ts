import { createHash } from 'node:crypto';
import { AdportError, guardedWriteTool, type AnyToolDefinition, type WriteOperation } from '@adport/core';
import { offlineAdjustments, offlineTimeTicks, offlineUpload } from './offline-conversion-schemas.js';
import { MicrosoftNativeService, type MicrosoftPlan, type MicrosoftRow as Row } from './native.js';
import type { MicrosoftAdsClient, RequestScope } from './client.js';
import type { MicrosoftConversionService } from './conversions.js';
import type { MicrosoftAdsProvider } from './provider.js';

export const MICROSOFT_OFFLINE_CONVERSION_WRITES = new Set(['microsoft_upload_offline_conversions', 'microsoft_upload_offline_conversion_adjustments']);
const record = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const wireFields = { microsoft_click_id: 'MicrosoftClickId', hashed_email_address: 'HashedEmailAddress', hashed_phone_number: 'HashedPhoneNumber', conversion_time: 'ConversionTime', conversion_value: 'ConversionValue', conversion_currency_code: 'ConversionCurrencyCode', external_attribution_credit: 'ExternalAttributionCredit', external_attribution_model: 'ExternalAttributionModel', adjustment_time: 'AdjustmentTime', adjustment_type: 'AdjustmentType', adjustment_value: 'AdjustmentValue', adjustment_currency_code: 'AdjustmentCurrencyCode' } as const;
const notes = [
  'This is a local preview. Microsoft has no dry run for offline imports or adjustments; no event is sent until apply.',
  'Events and adjustments can affect measured revenue, conversion counts and automated bidding. This tool preserves goal configuration, account auto-tagging, campaign status and budgets.',
  'Wait two hours after creating a goal. Receipt acceptance does not prove matching, attribution or reporting; reporting can take six hours. Click time and conversion-window eligibility cannot be checked from these inputs.',
  'Native deduplication retains the first original conversion for the same goal/click/time. Use a restatement or retraction to change a prior conversion. No global Adport event ledger or per-event readback is available.',
  'Approval is single-attempt. Failed or unknown rows are never retried automatically; reconcile batch SHA-256, original row indexes and aggregate upload diagnostics before requesting another preview.',
  'Private identifiers are omitted from previews, receipts and audit summaries. Full arguments are stored in the private pending approval; the agent applies them without copying them into the widget.',
];

/** PartialErrors is sparse and indexed into the request, not positional. No native messages/values are exposed. */
function outcome(value: unknown, count: number) {
  const errors: Array<{ index: number; code: number }> = [];
  let unmapped = 0, verified = record(value) && Object.keys(value).every(key => key === 'PartialErrors');
  const partial = record(value) ? value.PartialErrors : undefined;
  if (partial !== undefined && partial !== null && !Array.isArray(partial)) verified = false;
  if (Array.isArray(partial)) {
    if (partial.length > 20_000) { verified = false;unmapped++; }
    for (const item of partial.slice(0, 20_000)) {
      if (item === null) continue;
      if (!record(item) || !Number.isInteger(item.Index) || Number(item.Index) < 0 || Number(item.Index) >= count || !Number.isSafeInteger(item.Code) || Number(item.Code) <= 0) { unmapped++;continue; }
      errors.push({ index: Number(item.Index), code: Number(item.Code) });
    }
  }
  const failed = new Set(errors.map(error => error.index));
  const rows = Array.from({ length: count }, (_, index) => ({ index, status: failed.has(index) ? 'FAILED' : verified && !unmapped ? 'ACCEPTED' : 'UNKNOWN' }));
  return { receipt_verified: verified && !unmapped, accepted_count: rows.filter(row => row.status === 'ACCEPTED').length, failed_count: failed.size, unknown_count: rows.filter(row => row.status === 'UNKNOWN').length, rows, errors, unmapped_error_count: unmapped };
}

/** Official MicrosoftDocs@5bde65c3 and BingAds Python REST SDK@4b6fb31c, refreshed2026-11-06. */
export class MicrosoftOfflineConversionService extends MicrosoftNativeService {
  constructor(client: MicrosoftAdsClient, scope: (account: string, refresh?: boolean) => Promise<RequestScope>, campaign: (account: string, campaign: string) => Promise<unknown>, private readonly conversions: MicrosoftConversionService) {
    super(client, scope, campaign);
  }

  async plan(op: WriteOperation): Promise<MicrosoftPlan> {
    const adjusting = op.tool === 'microsoft_upload_offline_conversion_adjustments';
    if (op.provider !== 'microsoft' || !MICROSOFT_OFFLINE_CONVERSION_WRITES.has(op.tool) || op.kind !== (adjusting ? 'update' : 'create')) throw new AdportError('INVALID_INPUT', 'microsoft: offline conversion operation provider/kind mismatch');
    const input = adjusting ? offlineAdjustments.parse(op.payload) : offlineUpload.parse(op.payload);
    const scope = await this.accountScope(op.accountId, true), current = await this.conversions.get(op.accountId, input.goal_id, 'OfflineConversion');
    if (current.snapshot_hash !== input.expected_goal_hash) throw new AdportError('PENDING_MISMATCH', 'microsoft: offline goal or auto-tagging configuration changed; read it and preview again');
    const goal = current.goal;
    if (goal.Type !== 'OfflineConversion' || !['Account', 'Customer'].includes(String(goal.Scope)) || !['Active', 'Paused'].includes(String(goal.Status)) || typeof goal.Name !== 'string' || !goal.Name.trim()) throw new AdportError('INVALID_INPUT', 'microsoft: an available Account/Customer offline goal with a concrete name and status is required');
    const source: Row[] = 'conversions' in input ? input.conversions : input.adjustments;
    const now = BigInt(Date.now()) * 10_000n, maxAge = 90n * 86400n * 10_000_000n, identities = new Set<string>();
    for (const row of source) {
      const time = offlineTimeTicks(String(row.conversion_time));
      if (time > now || time < now - maxAge) throw new AdportError('INVALID_INPUT', 'microsoft: original conversion times must be in UTC within the last90days and not in the future');
      if (adjusting && (offlineTimeTicks(String(row.adjustment_time)) < time || offlineTimeTicks(String(row.adjustment_time)) > now)) throw new AdportError('INVALID_INPUT', 'microsoft: adjustment time must be at/after the original conversion and not in the future');
      if ((row.hashed_email_address || row.hashed_phone_number) && goal.IsEnhancedConversionsEnabled !== true) throw new AdportError('INVALID_INPUT', 'microsoft: hashed identifiers require an already enabled enhanced-conversion goal; no setting or terms are changed');
      if ((row.external_attribution_credit !== undefined || row.external_attribution_model !== undefined) && goal.IsExternallyAttributed !== true) throw new AdportError('INVALID_INPUT', 'microsoft: external attribution fields require a verified externally attributed goal');
      const identity = digest({ time: time.toString(), ...(row.microsoft_click_id ? { click: row.microsoft_click_id } : { email: row.hashed_email_address, phone: row.hashed_phone_number }) });
      if (identities.has(identity)) throw new AdportError('INVALID_INPUT', 'microsoft: duplicate original conversion identities in this batch; submit at most one operation per original identity');
      identities.add(identity);
    }
    const bodyRows = source.map(row => ({ ConversionName: goal.Name, ...Object.fromEntries(Object.entries(row).map(([key, value]) => [wireFields[key as keyof typeof wireFields], value])) }));
    const path = adjusting ? 'OfflineConversionAdjustments/Apply' : 'OfflineConversions/Apply';
    const body = { [adjusting ? 'OfflineConversionAdjustments' : 'OfflineConversions']: bodyRows };
    const batchHash = digest({ account: op.accountId, path, body }), count = source.length;
    const valueRanges = new Map<string, { currency: string; records: number; minimum: number; maximum: number }>();
    for (const row of source) {
      const value = adjusting ? row.adjustment_value : row.conversion_value;
      if (typeof value !== 'number') continue;
      const currency = String((adjusting ? row.adjustment_currency_code : row.conversion_currency_code) ?? '(goal default)'), previous = valueRanges.get(currency);
      valueRanges.set(currency, { currency, records: (previous?.records ?? 0) + 1, minimum: Math.min(previous?.minimum ?? value, value), maximum: Math.max(previous?.maximum ?? value, value) });
    }
    const changes = [`${count} ${adjusting ? 'adjustments' : 'conversions'} for offline goal ${input.goal_id}.`, `Approved native batch SHA-256: ${batchHash}.`, adjusting ? 'Restatements replace recorded values; retractions remove previously recorded conversions. Original conversion time identifies the record; adjustment time records the adjustment.' : 'Omitted conversion value and currency use the goal revenue defaults. Values are whole currency units, not budget micros.'];
    const notices = [...notes, ...(goal.Status === 'Paused' ? ['This goal is Paused. It stays paused; receipt acceptance does not imply that these records will be counted.'] : []), ...(record(goal.Revenue) && goal.Revenue.Type === 'NoValue' ? ['Goal revenue is NoValue; supplying monetary values does not change the goal into a revenue-tracking goal.'] : []), ...(!current.auto_tagging_enabled ? ['Click-ID auto-tagging is disabled and remains disabled. An uploaded click ID must already identify a real native click.'] : [])];
    let details: unknown, warnings: string[] = [];
    return { summary: `${adjusting ? 'Adjust' : 'Import'} ${count} Microsoft offline conversion${count === 1 ? '' : 's'} · batch ${batchHash}`, changes, notes: notices, coercions: [], budgetDeltas: [],
      review: { provider: 'microsoft', accountId: op.accountId, kind: op.kind, title: adjusting ? 'Adjust offline conversions' : 'Import offline conversions', fields: [
        { label: 'Goal', after: `${goal.Name} [${input.goal_id}]` }, { label: 'Goal scope', after: goal.Scope }, { label: 'Goal status', after: goal.Status }, { label: 'Records', after: count },
        { label: 'Identifier matching', after: { click_ids: source.filter(row => row.microsoft_click_id).length, hashed_emails: source.filter(row => row.hashed_email_address).length, hashed_phones: source.filter(row => row.hashed_phone_number).length } },
        ...(adjusting ? [{ label: 'Adjustments', after: { restatements: source.filter(row => row.adjustment_type === 'Restate').length, retractions: source.filter(row => row.adjustment_type === 'Retract').length } }] : [{ label: 'Goal revenue defaults', after: goal.Revenue ?? 'Not reported' }]),
        { label: 'Explicit value ranges (whole currency units)', after: [...valueRanges.values()] },
        { label: 'Batch SHA-256', after: batchHash },
      ], notices }, resultDetails: () => details, resultWarnings: () => warnings,
      execute: async () => {
        let result: unknown;
        try { result = await this.client.request<unknown>('campaign', 'POST', path, body, scope, { privatePayload: true }); }
        catch { throw new AdportError('PROVIDER_ERROR', 'microsoft: offline batch outcome is unknown; private native response details were omitted. Reconcile upload diagnostics before another preview. No request was retried.', { batch_sha256: batchHash, target_goal_id: input.goal_id, record_count: count, ...outcome(null, count), processed: false }); }
        const receipt = outcome(result, count);
        details = { status: receipt.accepted_count ? 'ACCEPTED_FOR_PROCESSING' : 'PARTIAL_OR_UNCONFIRMED', receipt_status: receipt.accepted_count === count ? 'ALL_ACCEPTED' : receipt.unknown_count ? 'UNCONFIRMED' : 'PARTIAL', processed: false, account_id: op.accountId, target_goal_id: input.goal_id, batch_sha256: batchHash, record_count: count, ...receipt, next_tool: 'microsoft_offline_conversion_goal_report' };
        if (!receipt.accepted_count) throw new AdportError('PROVIDER_ERROR', 'microsoft: no offline records were confirmed accepted. Reconcile the returned row outcomes and native upload diagnostics; no automatic retry.', details);
        if (receipt.accepted_count < count) warnings = [`Microsoft accepted ${receipt.accepted_count} of ${count} rows for processing; ${receipt.failed_count} failed and ${receipt.unknown_count} remain unknown. Acceptance is not attribution. Inspect original row indexes before a new upload.`];
        // The API assigns no event IDs. This ID names the existing target goal only.
        return [input.goal_id];
      },
    };
  }
}

export function microsoftOfflineConversionTools(_provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  const catalog = { category: 'measurement' as const, exposure: 'specialist' as const };
  return [
    guardedWriteTool({ name: 'microsoft_upload_offline_conversions', namespace: 'microsoft', provider: 'microsoft', catalog, kind: 'create', sensitiveInputs: ['conversions'], description: 'Import 1–1,000 offline conversions into an existing goal with expected_goal_hash. Local preview sends no events; apply returns sparse indexed failures and acceptance for processing, not attribution. Uses the current exact goal name, preserves its configuration and never retries. Already hashed identifiers require enhanced conversions to be enabled.', payload: offlineUpload }),
    guardedWriteTool({ name: 'microsoft_upload_offline_conversion_adjustments', namespace: 'microsoft', provider: 'microsoft', catalog, kind: 'update', sensitiveInputs: ['adjustments'], description: 'Restate or retract 1–1,000 previously imported offline conversions with expected_goal_hash. Original conversion_time identifies each record; adjustment_time records the adjustment. Local preview sends nothing. Returns indexed failures and processing acceptance; no automatic retry or per-event readback.', payload: offlineAdjustments }),
  ];
}
