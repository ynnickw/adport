import { AdportError, type AdProvider, type Account, type AnalyticsGoal, type AcquisitionQuery, type AcquisitionReport,
  type NormalizedQuery, type Report, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import type { MatomoClient } from './client.js';
import { readAcquisition, records } from './acquisition.js';

export function matomoSiteId(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,9}$/.test(String(value)))
    throw new AdportError('INVALID_INPUT', 'Matomo requires a positive numeric site ID.');
  return String(value);
}

export interface MatomoSite { id: string; name: string; timezone?: string; currency?: string; ecommerce: boolean }
function returnedSiteId(value: unknown) {
  try { return matomoSiteId(value); } catch { throw new AdportError('PROVIDER_ERROR', 'Matomo returned an invalid site ID.'); }
}
const siteInfo = (raw: Record<string, unknown>): MatomoSite => ({
  id: returnedSiteId(raw.idsite), name: String(raw.name ?? raw.idsite),
  ...(typeof raw.timezone === 'string' ? { timezone: raw.timezone } : {}),
  ...(typeof raw.currency === 'string' ? { currency: raw.currency } : {}), ecommerce: Number(raw.ecommerce) === 1,
});

export class MatomoProvider implements AdProvider {
  readonly id = 'matomo';
  get acquisitionAnalytics() { return this; }
  constructor(private readonly client: MatomoClient) {}
  capabilities() { return { serverDryRun: false, reporting: false }; }
  async report(_query: NormalizedQuery): Promise<Report> { throw new AdportError('INVALID_INPUT', 'Use analytics_acquisition_report for this website.'); }
  async previewWrite(_op: WriteOperation): Promise<WritePreview> { throw new AdportError('POLICY_VIOLATION', 'Website analytics is read-only.'); }
  async applyWrite(_op: WriteOperation): Promise<WriteResult> { throw new AdportError('POLICY_VIOLATION', 'Website analytics is read-only.'); }

  async listAccounts(): Promise<Account[]> {
    return records(await this.client.call('SitesManager.getSitesWithAtLeastViewAccess')).map(siteInfo).map(({ id, name, currency, timezone }) =>
      ({ provider: this.id, id, name, currency, timezone }));
  }

  private async site(accountId: string): Promise<MatomoSite> {
    const id = matomoSiteId(accountId);
    const raw = await this.client.call('SitesManager.getSiteFromId', { idSite: id });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || String((raw as Record<string, unknown>).idsite) !== id)
      throw new AdportError('PROVIDER_ERROR', 'Matomo returned no settings for the requested site.');
    return siteInfo(raw as Record<string, unknown>);
  }

  private async configuredGoals(site: MatomoSite): Promise<AnalyticsGoal[]> {
    const raw = await this.client.call('Goals.getGoals', { idSite: site.id });
    const goals: AnalyticsGoal[] = records(raw).filter(g => !Number(g.deleted)).map(g => {
      if (!/^[1-9]\d*$/.test(String(g.idgoal)) || typeof g.name !== 'string' || (g.idsite != null && String(g.idsite) !== site.id))
        throw new AdportError('PROVIDER_ERROR', 'Matomo returned an invalid goal for this site.');
      return { id: String(g.idgoal), name: g.name, counting_method: Number(g.allow_multiple) === 1 ? 'per_conversion' : 'once_per_visit' };
    });
    if (site.ecommerce) goals.push({ id: 'ecommerceOrder', name: 'Ecommerce orders', counting_method: 'per_order' });
    return goals;
  }

  async listGoals(accountId: string) { return this.configuredGoals(await this.site(accountId)); }

  async acquisitionReport(query: AcquisitionQuery): Promise<AcquisitionReport> {
    const site = await this.site(query.account_id);
    if (query.goal_ids) {
      const goals = await this.configuredGoals(site);
      if (query.goal_ids.some(id => !goals.some(g => g.id === id))) throw new AdportError('INVALID_INPUT', 'A selected goal is missing from this site. Refresh analytics_goals.');
    }
    return readAcquisition(this.client, site, query);
  }
}
