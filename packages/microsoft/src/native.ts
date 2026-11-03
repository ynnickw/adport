import { AdportError, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { MicrosoftAdsClient, type MicrosoftService, type RequestScope } from './client.js';

export type MicrosoftRow = Record<string, unknown>;
export type MicrosoftPlan = Omit<WritePreview, 'serverValidated'> & { execute: () => Promise<string[]> };
export const microsoftId = z.string().regex(/^[1-9]\d*$/);
export const microsoftRows = (value: unknown): MicrosoftRow[] => z.array(z.record(z.string(), z.unknown())).parse(value ?? []);
export const microsoftRow = (value: unknown): MicrosoftRow => z.record(z.string(), z.unknown()).parse(value);
export function microsoftNativeId(value: unknown): string {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) throw new AdportError('PROVIDER_ERROR', 'microsoft: unsafe native resource ID');
  const parsed = microsoftId.safeParse(typeof value === 'number' ? String(value) : value);
  if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'microsoft: invalid native resource ID');
  return parsed.data;
}

function compactErrors(errors: unknown[]): MicrosoftRow[] {
  const grouped = new Map<string, MicrosoftRow>();
  for (const value of errors) {
    const error = microsoftRow(value), { PublisherCountry, ...base } = error;
    if (typeof PublisherCountry !== 'string') { grouped.set(`item:${grouped.size}`, error); continue; }
    const key = JSON.stringify(base), previous = grouped.get(key);
    if (previous) previous.PublisherCountries = [...new Set([...(previous.PublisherCountries as string[]), PublisherCountry])];
    else grouped.set(key, { ...base, PublisherCountries: [PublisherCountry] });
  }
  return [...grouped.values()];
}

/** Shared scoped REST access. NestedPartialErrors are not interchangeable with PartialErrors. */
export class MicrosoftNativeService {
  constructor(protected readonly client: MicrosoftAdsClient, private readonly scope: (account: string, refresh?: boolean) => Promise<RequestScope>, private readonly lookupCampaign: (account: string, campaign: string) => Promise<unknown>) {}

  protected async accountScope(account: string, refresh = false): Promise<RequestScope> {
    microsoftId.parse(account);
    const scope = await this.scope(account, refresh);
    if (!scope.customerId || scope.customerAccountId !== account) throw new AdportError('INVALID_INPUT', 'microsoft: selected account ownership could not be verified');
    return scope;
  }

  protected async request(account: string, path: string, body: MicrosoftRow, method: 'POST' | 'PUT' | 'DELETE' = 'POST', service: MicrosoftService = 'campaign'): Promise<MicrosoftRow> {
    const scope = await this.accountScope(account);
    const result = await this.client.request<MicrosoftRow>(service, method, path, body, scope);
    const errors = ['PartialErrors', 'NestedPartialErrors'].flatMap(key => {
      if (result[key] === undefined || result[key] === null) return [];
      if (!Array.isArray(result[key])) throw new AdportError('PROVIDER_ERROR', 'microsoft: malformed native error receipt');
      return result[key].filter(value => value !== null);
    });
    if (errors.length) {
      const negativeIds = Array.isArray(result.NegativeKeywordIds) ? result.NegativeKeywordIds.flatMap(group => group && typeof group === 'object' && Array.isArray(microsoftRow(group).Ids) ? [microsoftRow(group).Ids] : []) : [];
      const ids = [result.CampaignCriterionIds, result.AdExtensionIdentities, result.BudgetIds, result.ConversionGoalIds, result.UetTags, ...negativeIds].flatMap(value => Array.isArray(value) ? value.flatMap(item => {
        const id = item && typeof item === 'object' ? microsoftRow(item).Id : item;
        return id === null || id === undefined ? [] : [microsoftNativeId(id)];
      }) : []);
      const compact = compactErrors(errors), summary = [...new Set(compact.map(value => `${value.Code ?? '?'} ${value.ErrorCode ?? ''}: ${value.Message ?? 'nested native error'}`))].slice(0, 5).join('; ');
      throw new AdportError('PROVIDER_ERROR', `microsoft: ${path} returned partial errors (${summary}); reconcile successful resource IDs before retrying`, { resourceIds: ids, errors: compact, nativeErrorCount: errors.length });
    }
    return result;
  }

  protected async campaign(account: string, campaign: string): Promise<MicrosoftRow> {
    microsoftId.parse(account);
    microsoftId.parse(campaign);
    const result = microsoftRow(await this.lookupCampaign(account, campaign));
    if (microsoftNativeId(result.Id) !== campaign) throw new AdportError('INVALID_INPUT', 'microsoft: campaign ownership mismatch');
    return result;
  }
}
