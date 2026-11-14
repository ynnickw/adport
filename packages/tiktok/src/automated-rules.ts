import { AdportError, defineTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import type { TikTokAdsProvider } from './provider.js';
import { nativeListComplete } from './pagination.js';

const id = z.string().regex(/^[1-9]\d*$/);
const nativeId = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()]).transform(String);
const dimension = z.enum(['CAMPAIGN', 'ADGROUP', 'AD']);
const status = z.enum(['ON', 'OFF', 'DELETED']);
const lang = z.enum(['EN', 'ZH', 'JA']).default('EN');
const paging = { page: z.number().int().positive().safe().default(1), page_size: z.number().int().positive().max(100).default(10).describe('Adport limit: 100 records per page') };
const ruleInfo = z.array(z.string().min(1)).min(1).max(100);
const filters = { status: status.optional(), rule_info: ruleInfo.optional(), data_dimension: dimension.optional() };
const datetime = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).refine(value => {
  const parsed = new Date(value.replace(' ', 'T') + 'Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19).replace('T', ' ') === value;
}, 'Use a valid UTC datetime: YYYY-MM-DD HH:MM:SS');
export const automatedRuleList = z.object({ account_id: id, filtering: z.object(filters).strict().optional(), tzone: z.string().min(1).optional(), ...paging }).strict();
export const automatedRuleGet = z.object({ account_id: id, rule_ids: z.array(id).min(1).max(100).refine(values => new Set(values).size === values.length, 'Rule IDs must be unique; Adport limit: 100') }).strict();
export const automatedRuleResults = z.object({ account_id: id, lang, filtering: z.object({
  ...filters,
  // The published result-filter enum uses this spelling; keep the documented wire value.
  action: z.enum(['TURN_ON', 'TURN_OFF', 'MESSAGE', 'DAILY_BUDGET', 'LIFERIME_BUDGET', 'BID']).optional(),
  time: z.tuple([datetime, datetime]).refine(([start, end]) => start <= end, 'End time must not precede start time').optional(),
}).strict().optional(), ...paging }).strict();
const resultPair = z.object({ rule_id: id, exec_id: id }).strict();
export const automatedRuleResultDetails = z.object({ account_id: id, lang, result_detail: z.array(resultPair).min(1).max(100).refine(values => new Set(values.map(value => `${value.rule_id}:${value.exec_id}`)).size === values.length, 'Rule/execution pairs must be unique; Adport limit: 100') }).strict();

const rule = z.looseObject({ rule_id: nativeId, name: z.string().optional(), rule_status: z.string().optional() });
const pageInfo = z.looseObject({ page: z.number().int().positive().safe(), page_size: z.number().int().positive().safe(), total_page: z.number().int().nonnegative().safe().optional(), total_number: z.number().int().nonnegative().safe().optional() });
const pageResponse = z.looseObject({ rules: z.array(rule), page_info: pageInfo.optional() });
const resultResponse = z.looseObject({ result_details: z.array(z.looseObject({ rule_id: nativeId, exec_id: nativeId })) });
const record = z.record(z.string(), z.unknown());
const output = z.looseObject({ records: z.array(record), complete: z.boolean().nullable(), truncated: z.boolean(), next_page: z.number().int().positive().safe().optional() });
const notes = ['TikTok restricts automated-rule creation to direct advertisers; its current documentation excludes SaaS platforms managing advertisers. These tools only inspect existing rules and execution results.'];
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Native v1.3 docs and TikTok-owned SDK f809c396, inspected 2026-11-05. */
export class TikTokAutomatedRulesService {
  constructor(private readonly client: TikTokClient) {}

  private scoped(value: unknown, account: string): unknown {
    if (Array.isArray(value)) return value.map(item => this.scoped(item, account));
    if (!object(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (['advertiser_id', 'rule_id', 'exec_id', 'task_exec_id', 'object_dimension_id'].includes(key)) {
        const parsed = nativeId.safeParse(item);
        if (!parsed.success || key === 'advertiser_id' && parsed.data !== account) throw new AdportError('PROVIDER_ERROR', 'tiktok: rule response contains an unverifiable ID or a different advertiser');
        return [key, parsed.data];
      }
      if (key === 'dimension_ids') {
        const parsed = z.array(nativeId).safeParse(item);
        if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'tiktok: rule object IDs could not be verified');
        return [key, parsed.data];
      }
      return [key, this.scoped(item, account)];
    }));
  }

  private records(rows: Array<z.infer<typeof rule>>, history: boolean): Row[] {
    return rows.map(value => {
      const result = object(value.rule_check_result) ? value.rule_check_result : object(value.last_check_result_summary) ? value.last_check_result_summary : undefined;
      const identity = history ? { ...(result?.task_exec_id !== undefined ? { id: `${value.rule_id}:${result.task_exec_id}` } : {}), rule_id: value.rule_id } : { id: value.rule_id };
      return { ...identity, ...(value.name !== undefined ? { name: value.name } : {}), ...(value.rule_status !== undefined ? { status: value.rule_status } : {}),
        ...(Array.isArray(value.actions) ? { action_types: value.actions.filter(object).map(action => action.subject_type) } : {}),
        ...(Array.isArray(value.apply_objects) ? { applies_to: value.apply_objects.filter(object).map(target => target.dimension) } : {}),
        ...(object(value.rule_exec_info) ? { schedule: value.rule_exec_info } : {}),
        ...(result ? { last_result: result } : {}),
      };
    });
  }

  private async readPage(path: string, account: string, params: Row, requestedIds?: string[]) {
    const parsed = pageResponse.safeParse(this.scoped(await this.client.get(path, { advertiser_id: account, ...params }), account));
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'tiktok: automated-rule response shape could not be verified');
    const data = parsed.data, page = data.page_info, history = path === 'optimizer/rule/result/list';
    if (!history && new Set(data.rules.map(value => value.rule_id)).size !== data.rules.length || requestedIds && data.rules.some(value => !requestedIds.includes(value.rule_id))) throw new AdportError('PROVIDER_ERROR', 'tiktok: automated-rule response has duplicate or unrequested rule IDs');
    if (typeof params.page === 'number' && (data.rules.length > Number(params.page_size) || page && (page.page !== params.page || page.page_size !== params.page_size))) throw new AdportError('PROVIDER_ERROR', 'tiktok: automated-rule pagination does not match the requested page');
    const complete = nativeListComplete(page, data.rules.length);
    return { ...data, records: this.records(data.rules, history), complete, truncated: complete !== true, next_page: undefined,
      ...(!requestedIds && complete === false && Number.isSafeInteger(Number(params.page) + 1) ? { next_page: Number(params.page) + 1 } : {}),
      ...(requestedIds ? { requested_rule_ids: requestedIds, unreturned_rule_ids: requestedIds.filter(value => !data.rules.some(row => row.rule_id === value)), all_requested_ids_returned: requestedIds.every(value => data.rules.some(row => row.rule_id === value)) } : {}),
      notes: [...notes, ...(complete === null ? ['Native pagination is missing or contradictory; completeness and absence are unconfirmed.'] : []), ...(requestedIds ? ['Unreturned IDs are not proof that a rule does not exist. This endpoint has no documented continuation parameter.'] : [])],
    };
  }

  list(raw: z.input<typeof automatedRuleList>) {
    const { account_id, ...input } = automatedRuleList.parse(raw);
    return this.readPage('optimizer/rule/list', account_id, input);
  }

  get(raw: z.input<typeof automatedRuleGet>) {
    const { account_id, rule_ids } = automatedRuleGet.parse(raw);
    return this.readPage('optimizer/rule/get', account_id, { rule_ids }, rule_ids);
  }

  results(raw: z.input<typeof automatedRuleResults>) {
    const { account_id, ...input } = automatedRuleResults.parse(raw);
    return this.readPage('optimizer/rule/result/list', account_id, input);
  }

  async details(raw: z.input<typeof automatedRuleResultDetails>) {
    const { account_id, ...input } = automatedRuleResultDetails.parse(raw);
    const parsed = resultResponse.safeParse(this.scoped(await this.client.get('optimizer/rule/result/get', { advertiser_id: account_id, ...input }), account_id));
    if (!parsed.success || parsed.data.result_details.some(row => !input.result_detail.some(pair => pair.rule_id === row.rule_id && pair.exec_id === row.exec_id))) throw new AdportError('PROVIDER_ERROR', 'tiktok: execution details do not match the requested rule/execution pairs');
    return { ...parsed.data, records: parsed.data.result_details, complete: null, truncated: true, notes: [...notes, 'Native execution details have no documented paging/completeness marker; omitted objects or executions are not proof of absence.'] };
  }
}

export function tiktokAutomatedRuleTools(provider: TikTokAdsProvider): AnyToolDefinition[] {
  const shared = { namespace: 'tiktok', output, presentation: 'records' as const, catalog: { category: 'administration' as const, exposure: 'specialist' as const }, annotations: { readOnly: true } };
  const pagination = { cursorInput: 'page', cursorOutput: 'next_page' };
  return [
    defineTool({ ...shared, name: 'tiktok_automated_rules', description: 'Inspect existing advertiser automated rules by native status, ID/name and object dimension. Explicit page certainty and Load more; Adport limit100/page. Does not create rules or trigger actions.', input: automatedRuleList, pagination, handler: input => provider.automatedRules.list(input) }),
    defineTool({ ...shared, name: 'tiktok_get_automated_rules', description: 'Inspect explicit advertiser rule IDs, preserving configuration, native IDs and execution summaries. Unreturned IDs are not proof of absence; Adport limit100 IDs/request.', input: automatedRuleGet, handler: input => provider.automatedRules.get(input) }),
    defineTool({ ...shared, name: 'tiktok_automated_rule_results', description: 'Read existing rule execution history with native filters and UTC time range. Preserves rule configuration and execution summaries; supports paging, not action execution.', input: automatedRuleResults, pagination, handler: input => provider.automatedRules.results(input) }),
    defineTool({ ...shared, name: 'tiktok_automated_rule_result_details', description: 'Read per-object results for explicit native rule/execution ID pairs. Provider errors and exact IDs are retained; no execution, notifications or budget changes.', input: automatedRuleResultDetails, handler: input => provider.automatedRules.details(input) }),
  ];
}
