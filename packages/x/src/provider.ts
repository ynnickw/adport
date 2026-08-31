import { z } from 'zod';
import { AdportError, resolveDateRange, type AdProvider, type MetricName, type NormalizedQuery, type Report, type ReportRow, type StandardActions, type WriteGuard, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { XAdsClient } from './client.js';
import { XAdsEntities } from './entities.js';
import { XAdsAnalytics, X_PLACEMENTS, xAccountMidnight } from './analytics.js';
import { planXWrite } from './writes.js';

type BaseMetric = 'spend' | 'impressions' | 'clicks';
type Metrics = Partial<Record<BaseMetric, number>>;
interface Entity { id: string; name: string; status: string; currency: string; type: string }
const DERIVED = { ctr: ['clicks', 'impressions', 100], cpc: ['spend', 'clicks', 1], cpm: ['spend', 'impressions', 1000] } as const;
const DAY = 86_400_000;

export class XAdsProvider extends XAdsEntities implements AdProvider {
  readonly id = 'x';
  private readonly analytics: XAdsAnalytics;
  constructor(client: XAdsClient, analytics?: XAdsAnalytics) { super(client); this.analytics = analytics ?? new XAdsAnalytics(client); }
  capabilities() { return { serverDryRun: false }; }
  standardActions(): StandardActions { return { pauseCampaign: (accountId, campaignId) => ({ tool: 'x_set_campaign_status', input: { account_id: accountId, campaign_id: campaignId, status: 'PAUSED' } }) }; }
  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    const { execute: _execute, ...preview } = await planXWrite(this, op, guard); return { ...preview, serverValidated: false };
  }
  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> {
    return { applied: true, resourceIds: await (await planXWrite(this, op, guard)).execute() };
  }
  async report(query: NormalizedQuery): Promise<Report> {
    const range = resolveDateRange(query.dateRange);
    z.iso.date().parse(range.start); z.iso.date().parse(range.end);
    if (range.end < range.start) throw new AdportError('INVALID_INPUT', 'x: report end precedes start');
    const needed = new Set<BaseMetric>();
    for (const metric of query.metrics) {
      if (['spend', 'impressions', 'clicks'].includes(metric)) needed.add(metric as BaseMetric);
      else if (metric in DERIVED) for (const dep of DERIVED[metric as keyof typeof DERIVED].slice(0, 2)) needed.add(dep as BaseMetric);
    }
    if (!needed.size) throw new AdportError('INVALID_INPUT', 'x: supported normalized metrics are spend, impressions, link clicks, ctr, cpc and cpm; conversion normalization is not yet verified');
    const limit = query.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AdportError('INVALID_INPUT', 'x: report limit must be a positive integer');
    const groups = [...(needed.has('spend') ? ['BILLING'] : []), ...(needed.has('clicks') || needed.has('impressions') ? ['ENGAGEMENT'] : [])];
    const rows: ReportRow[] = [];
    const accounts = [...new Set(query.accountIds ?? (await this.listAccounts()).map(a => a.id))];
    for (const accountId of accounts) {
      const account = await this.getAccount(accountId);
      const start = xAccountMidnight(range.start, account.timezone);
      const endDate = new Date(Date.parse(`${range.end}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
      const end = xAccountMidnight(endDate, account.timezone);
      if (account.timezone_switch_at && (!Number.isFinite(Date.parse(account.timezone_switch_at)) || start < Date.parse(account.timezone_switch_at))) throw new AdportError('INVALID_INPUT', 'x: requested dates predate the account timezone switch; its previous reporting timezone is unknown');
      let entities = await this.reportEntities(accountId, query.level);
      if (query.level === 'account' && new Set(entities.map(e => e.currency)).size > 1) throw new AdportError('PROVIDER_ERROR', 'x: cannot aggregate campaigns with different currencies into one account total');
      const truncated = query.level !== 'account' && entities.length > limit - rows.length;
      if (query.level !== 'account') entities = entities.slice(0, Math.max(0, limit - rows.length));
      const totals = new Map<string, Metrics>();
      const entityKey = (entity: Entity) => `${entity.type}:${entity.id}`;
      for (const type of new Set(entities.map(e => e.type))) {
        const typed = entities.filter(e => e.type === type);
        for (let offset = 0; offset < typed.length; offset += 20) {
          const batch = typed.slice(offset, offset + 20);
          const accumulated = new Map(batch.map(e => [e.id, undefined as Metrics | undefined]));
          for (let from = start; from < end;) {
            const asynchronous = end - start > 7 * DAY || end < Date.now() - 7 * DAY || type === 'MEDIA_CREATIVE';
            const to = Math.min(end, from + (asynchronous ? 30 : 7) * DAY);
            for (const placement of X_PLACEMENTS) {
              const stats = await this.analytics.totals(accountId, { entity: type, entity_ids: batch.map(e => e.id).join(','), start_time: new Date(from).toISOString(), end_time: new Date(to).toISOString(), granularity: 'TOTAL', placement, metric_groups: groups.join(',') }, asynchronous);
              for (const row of stats.data) {
                const source = row.id_data[0]!.metrics, metrics: Metrics = {};
                for (const [key, field, divisor] of [['spend', 'billed_charge_local_micro', 1_000_000], ['impressions', 'impressions', 1], ['clicks', 'url_clicks', 1]] as const) {
                  const value = source[field];
                  if (value !== undefined && needed.has(key)) metrics[key] = (value?.[0] ?? 0) / divisor;
                }
                accumulated.set(row.id, add(accumulated.get(row.id), metrics));
              }
            }
            from = to;
          }
          for (const entity of batch) totals.set(entityKey(entity), accumulated.get(entity.id) ?? {});
        }
      }
      if (query.level === 'account') {
        if (entities.length) {
          let total: Metrics | undefined;
          for (const entity of entities) total = add(total, totals.get(entityKey(entity))!);
          rows.push({ provider: this.id, accountId, entity: { level: 'account', id: accountId, name: account.name, status: account.approval_status }, metrics: normalize(total ?? {}, query.metrics) });
        }
      } else for (const entity of entities) rows.push({ provider: this.id, accountId, entity: { level: query.level, id: query.level === 'ad' ? entityKey(entity) : entity.id, name: entity.name, status: entity.status }, metrics: normalize(totals.get(entityKey(entity))!, query.metrics) });
      if (truncated) return { rows, truncated: true };
      if (rows.length >= limit) {
        return { rows, ...(accounts.indexOf(accountId) < accounts.length - 1 ? { truncated: true } : {}) };
      }
    }
    return { rows };
  }
  private async reportEntities(accountId: string, level: NormalizedQuery['level']): Promise<Entity[]> {
    if (level === 'account' || level === 'campaign') return (await this.listCampaigns(accountId)).filter(c => c.entity_status !== 'DRAFT').map(c => ({ id: c.id, name: c.name, currency: c.currency, status: c.entity_status, type: 'CAMPAIGN' }));
    const allLines = await this.listLineItems(accountId);
    const lines = allLines.filter(l => l.entity_status !== 'DRAFT');
    if (level === 'ad_group') return lines.map(l => ({ id: l.id, name: l.name, currency: l.currency, status: l.entity_status, type: 'LINE_ITEM' }));
    const lookup = new Map(allLines.map(l => [l.id, l]));
    const tweets = await this.listPromotedTweets(accountId), media = await this.listMediaCreatives(accountId);
    const promoted = lines.some(l => l.product_type === 'PROMOTED_ACCOUNT') ? await this.listPromotedAccounts(accountId) : [];
    return [
      ...tweets.map(t => ({ ...t, type: 'PROMOTED_TWEET', name: `Promoted post ${t.tweet_id}` })),
      ...media.map(t => ({ ...t, type: 'MEDIA_CREATIVE', name: `Media creative ${t.account_media_id}` })),
      ...promoted.map(t => ({ ...t, type: 'PROMOTED_ACCOUNT', name: `Promoted account ${t.user_id}` })),
    ].filter(t => {
      if (!lookup.has(t.line_item_id)) throw new AdportError('PROVIDER_ERROR', 'x: ad references an unknown line item');
      return lookup.get(t.line_item_id)!.entity_status !== 'DRAFT';
    }).map(t => {
      const parent = lookup.get(t.line_item_id);
      if (!parent) throw new AdportError('PROVIDER_ERROR', 'x: ad references an unknown or draft line item');
      return { id: t.id, name: t.name, status: t.entity_status, currency: parent.currency, type: t.type };
    });
  }
}
function add(previous: Metrics | undefined, next: Metrics): Metrics {
  if (!previous) return { ...next };
  const sum: Metrics = {};
  for (const key of ['spend', 'impressions', 'clicks'] as const) if (previous[key] !== undefined && next[key] !== undefined) {
    const value = previous[key]! + next[key]!;
    if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) throw new AdportError('PROVIDER_ERROR', 'x: report total exceeds safe numeric range');
    sum[key] = value;
  }
  return sum;
}
function normalize(values: Metrics, requested: MetricName[]) {
  const all: Partial<Record<MetricName, number>> = { ...values };
  for (const [metric, [numerator, denominator, factor]] of Object.entries(DERIVED)) if (values[numerator] !== undefined && values[denominator] !== undefined) all[metric as MetricName] = values[denominator] ? values[numerator]! / values[denominator]! * factor : 0;
  return Object.fromEntries(requested.filter(m => all[m] !== undefined).map(m => [m, all[m]]));
}
