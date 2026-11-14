import { AdportError, defineTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import { MicrosoftNativeService, microsoftId as id, microsoftNativeId as nativeId, microsoftRows as rows } from './native.js';
import type { MicrosoftAdsProvider } from './provider.js';

const range = z.object({ start_utc: z.iso.datetime(), end_utc: z.iso.datetime() }).refine(value => {
  const span = Date.parse(value.end_utc) - Date.parse(value.start_utc);
  return span >= 0 && span <= 7 * 86400000;
}, 'Use an ordered UTC interval of at most seven days');
const accountInput = z.object({ account_id: id, date_range: range });
const channels = z.enum(['CampaignManagementAPI', 'BulkAPI', 'WebUpload', 'Unknown']);
const goalInput = accountInput.extend({ goal_ids: z.array(id).min(1).max(20).refine(value => new Set(value).size === value.length, 'Goal IDs must be unique'), upload_channels: z.array(channels).min(1).refine(value => new Set(value).size === value.length && (!value.includes('Unknown') || value.length === 1), 'Use unique channels; Unknown cannot be combined with other channels').optional() });
const count = z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d+$/)]);
const rate = z.union([z.number().min(0).max(1), z.string().regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/)]);
const optionalCount = count.nullable().optional();
const alert = z.object({ Count: optionalCount, UnattributedReason: z.string().nullable().optional() });
const goalId = z.preprocess(nativeId, id);
const day = z.object({ GoalId: goalId, UploadDate: z.string(), SuccessCount: optionalCount, UnattributedCount: optionalCount, SuccessRate: rate.nullable().optional(), Alerts: z.array(alert).nullable().optional() });
const summary = z.object({ GoalId: goalId, ConversionName: z.string().nullable().optional(), OverallSuccessCount: optionalCount, OverallUnattributedCount: optionalCount, OverallSuccessRate: rate.nullable().optional(), OverallAlerts: z.array(alert).nullable().optional(), DailySummaries: z.array(day).nullable().optional() });
const daily = z.object({ UploadDate: z.string(), SuccessCount: optionalCount, FailureCount: optionalCount, FileUrlExpiryTimeUtc: z.string().nullable().optional(), file_available: z.boolean() });
const partialError = z.object({ index: z.number().int().nonnegative().optional(), goal_id: id.optional(), code: z.number().int().optional(), error_code: z.string().optional() });
const accountOutput = z.object({ account_id: id, date_range: range, rows: z.array(daily), notes: z.array(z.string()) });
const goalOutput = z.object({ account_id: id, date_range: range, rows: z.array(summary), errors: z.array(partialError), not_returned_goal_ids: z.array(id), notes: z.array(z.string()) });
const notes = ['Read-only upload diagnostics, not campaign performance or proof of incremental attribution. Counts preserve native strings and missing values; success rates are ratios, not percentages.', 'Input boundaries are UTC. Native UploadDate values are preserved; Microsoft documents DailySummary.UploadDate as local time. No conversion events are submitted.'];

/** Campaign Management v13 report aggregates only; never expose signed report files or pilot event records. */
export class MicrosoftOfflineReportService extends MicrosoftNativeService {
  async daily(input: z.infer<typeof accountInput>) {
    const result = await this.request(input.account_id, 'OfflineConversionReports/Query', { StartDateUtc: input.date_range.start_utc, EndDateUtc: input.date_range.end_utc });
    if (!Object.hasOwn(result, 'DailySummaries')) throw new AdportError('PROVIDER_ERROR', 'microsoft: offline upload report envelope is missing');
    const values = rows(result.DailySummaries).map(value => {
      if (!Object.hasOwn(value, 'SuccessCount') && !Object.hasOwn(value, 'FailureCount')) throw new AdportError('PROVIDER_ERROR', 'microsoft: offline report lacks aggregate counts; event-level records are not exposed by this tool');
      return daily.parse({ ...value, file_available: typeof value.FileUrl === 'string' && value.FileUrl.length > 0 });
    });
    return accountOutput.parse({ account_id: input.account_id, date_range: input.date_range, rows: values, notes: [...notes, 'Signed FileUrl values and pilot event/customer fields are omitted. This tool does not download raw conversion files.'] });
  }

  async goals(input: z.infer<typeof goalInput>) {
    const available = rows((await this.request(input.account_id, 'ConversionGoals/QueryByIds', { ConversionGoalIds: input.goal_ids, ConversionGoalTypes: 'OfflineConversion' })).ConversionGoals);
    if (available.length !== input.goal_ids.length || new Set(available.map(value => nativeId(value.Id))).size !== available.length || available.some(value => value.Type !== 'OfflineConversion' || !input.goal_ids.includes(nativeId(value.Id)))) throw new AdportError('INVALID_INPUT', 'microsoft: requested offline goals are not all available in the selected account');
    const scope = await this.accountScope(input.account_id);
    // This read can return successful summaries alongside per-goal failures.
    // Preserve those failures explicitly instead of the mutation helper's throw.
    const result = await this.client.request<Record<string, unknown>>('campaign', 'POST', 'OfflineConversionReport/QueryByGoalIds', { StartDateUtc: input.date_range.start_utc, EndDateUtc: input.date_range.end_utc, GoalIds: input.goal_ids, UploadChannelFilter: input.upload_channels?.join(', ') ?? null }, scope);
    if (!Object.hasOwn(result, 'OfflineGoalConversionSummaries') || result.NestedPartialErrors !== undefined && result.NestedPartialErrors !== null && (!Array.isArray(result.NestedPartialErrors) || result.NestedPartialErrors.some(Boolean))) throw new AdportError('PROVIDER_ERROR', 'microsoft: offline goal report envelope is missing or contains unsupported nested errors');
    const values = rows(result.OfflineGoalConversionSummaries).map(value => summary.parse(value));
    if (new Set(values.map(value => value.GoalId)).size !== values.length || values.some(value => !input.goal_ids.includes(value.GoalId) || value.DailySummaries?.some(day => day.GoalId !== value.GoalId))) throw new AdportError('PROVIDER_ERROR', 'microsoft: offline report returned an unexpected or duplicate goal identity');
    const errors = z.array(z.record(z.string(), z.unknown()).nullable()).parse(result.PartialErrors ?? []).filter(value => value !== null).map(value => {
      if (value.Index !== undefined && value.Index !== null && (!Number.isInteger(value.Index) || Number(value.Index) < 0 || Number(value.Index) >= input.goal_ids.length)) throw new AdportError('PROVIDER_ERROR', 'microsoft: offline report error index is outside the requested goals');
      if (typeof value.Code !== 'number' && typeof value.ErrorCode !== 'string') throw new AdportError('PROVIDER_ERROR', 'microsoft: malformed offline report partial error');
      const index = typeof value.Index === 'number' ? value.Index : undefined;
      return partialError.parse({ ...(index !== undefined ? { index, goal_id: input.goal_ids[index] } : {}), ...(value.Code !== undefined ? { code: value.Code } : {}), ...(value.ErrorCode !== undefined ? { error_code: value.ErrorCode } : {}) });
    });
    return goalOutput.parse({ account_id: input.account_id, date_range: input.date_range, rows: values, errors, not_returned_goal_ids: input.goal_ids.filter(goal => !values.some(value => value.GoalId === goal)), notes: [...notes, 'Missing summaries and per-goal errors are explicit; absence does not mean zero conversions. Error messages, details and event/customer fields are omitted.'] });
  }
}

export function microsoftOfflineReportTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'microsoft_offline_conversion_reports', namespace: 'microsoft', description: 'Read daily offline-conversion upload success/failure counts in an explicit UTC interval (tool bound: seven days). Preserves native dates/counts; omits signed file URLs and pilot event/customer records. Downloads and event ingestion are separate workflows.', input: accountInput, output: accountOutput, annotations: { readOnly: true }, handler: input => provider.offlineReports.daily(input) }),
    defineTool({ name: 'microsoft_offline_conversion_goal_report', namespace: 'microsoft', description: 'Read offline conversion attribution diagnostics for up to 20 unique account-available OfflineConversion goals and at most seven days in UTC. Native channel flags are optional CSV filters. Returns aggregate/daily ratios and counts, explicit per-goal errors and missing summaries; never infers zero for missing data.', input: goalInput, output: goalOutput, annotations: { readOnly: true }, handler: input => provider.offlineReports.goals(input) }),
  ];
}
