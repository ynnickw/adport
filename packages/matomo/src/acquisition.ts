import { AdportError, type AcquisitionQuery, type AcquisitionReport, type AcquisitionRow } from '@adport/core';
import type { MatomoClient } from './client.js';
import type { MatomoSite } from './provider.js';

type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
export function records(raw: unknown): Row[] {
  const list = Array.isArray(raw) ? raw : object(raw) ? Object.values(raw) : null;
  if (!list || !list.every(object)) throw new AdportError('PROVIDER_ERROR', 'Unexpected Matomo report shape.');
  return list;
}
const maxRows = 10000;
function table(raw: unknown): Row[] {
  const rows = records(raw);
  if (rows.length > maxRows) throw new AdportError('PROVIDER_ERROR', 'This Matomo archive exceeds the report limit. Choose a shorter date range.');
  return rows;
}
const summary = (r: Row) => r.label === 'Others' || r.label === '-1' || Boolean(Number(r.is_summary));
const numeric = (v: unknown): number | null => (typeof v === 'number' || typeof v === 'string' && v.trim()) && Number.isFinite(Number(v)) ? Number(v) : null;

type Measures = { sessions: number | null; conversions: number | null; revenue: number | null; [key: string]: number | null };
function measures(r: Row, site: MatomoSite, ids: string[]): Measures {
  const goals = object(r.goals) ? r.goals : {};
  const goalMetric = (id: string, field: string) => {
    const goal = goals['idgoal=' + id];
    return goal === undefined ? 0 : object(goal) ? numeric(goal[field]) : null;
  };
  const m: Measures = {
    sessions: numeric(r.nb_visits), conversions: numeric(r.nb_conversions ?? (Object.keys(goals).length ? undefined : 0)),
    revenue: site.ecommerce ? goalMetric('ecommerceOrder', 'revenue') : numeric(r.revenue ?? (Object.keys(goals).length ? undefined : 0)),
  };
  for (const id of ids) m['goal:' + id] = goalMetric(id, 'nb_conversions');
  return m;
}

function combine(a: Measures, b: Measures, sign = 1): Measures {
  const result = { ...a };
  for (const key of Object.keys(a)) {
    const x = a[key], y = b[key];
    result[key] = x == null || y == null ? null : x + sign * y;
  }
  return result;
}
function hasData(m: Measures) { return Object.values(m).some(x => x === null || Math.abs(x) > 0.000001); }
function residual(total: Measures, used: Measures, notes: Set<string>): Measures {
  const diff = combine(total, used, -1);
  for (const [key, value] of Object.entries(diff)) {
    if (value !== null && Math.abs(value) < 0.000001) diff[key] = 0;
    else if (key !== 'revenue' && value !== null && value < 0) {
      diff[key] = null;
      notes.add('Matomo archives disagree on a subtotal. An unreconciled measure is unavailable.');
    }
  }
  return diff;
}
function row(dims: AcquisitionRow['dimensions'], m: Measures, ids: string[]): AcquisitionRow {
  const counts = ids.map(id => m['goal:' + id] ?? null);
  return { dimensions: dims, metrics: { sessions: m.sessions, revenue: m.revenue,
    conversions: ids.length ? counts.some(v => v === null) ? null : counts.reduce<number>((a, b) => a + b!, 0) : m.conversions },
    ...(ids.length ? { goal_counts: Object.fromEntries(ids.map((id, i) => [id, counts[i] ?? null])) } : {}) };
}

/** Only the source/medium archive contains joint rows. The name archive retains campaigns whose source or medium was never captured. */
async function groups(client: MatomoClient, params: Record<string, string>, site: MatomoSite, plugin: boolean, ids: string[], notes: Set<string>) {
  const read = async (method: string, options = {}) => table(await client.call(method, { ...params, ...options }));
  const [channels, names, pairs, sources, media] = await Promise.all([
    read('Referrers.getReferrerType'), read(plugin ? 'MarketingCampaignsReporting.getName' : 'Referrers.getCampaigns'),
    plugin ? read('MarketingCampaignsReporting.getSourceMedium', { expanded: '1' }) : [],
    plugin ? read('MarketingCampaignsReporting.getSource') : [], plugin ? read('MarketingCampaignsReporting.getMedium') : [],
  ]);
  const zero = measures({ nb_visits: 0 }, site, ids);
  const measuresFor = (r: Row) => measures(r, site, ids);
  let siteTotal = zero, namedTotal = zero;
  for (const channel of channels) siteTotal = combine(siteTotal, measuresFor(channel));
  const namedChildren = new Map<string, Measures>(), rows: AcquisitionRow[] = [];
  const sourceLabels = new Set(sources.map(r => r.label)), mediumLabels = new Set(media.map(r => r.label));
  const archivedLabels = sources.some(summary) || media.some(summary);
  for (const pair of pairs) {
    if (summary(pair)) continue;
    const label = String(pair.label), candidates: Array<[string | null, string | null]> = [];
    // Matomo omits empty components and joins the others with a literal separator, also legal inside a UTM value.
    if (sourceLabels.has(label)) candidates.push([label, null]);
    if (mediumLabels.has(label)) candidates.push([null, label]);
    for (let pos = label.indexOf(' - '); pos >= 0; pos = label.indexOf(' - ', pos + 1)) {
      const source = label.slice(0, pos), medium = label.slice(pos + 3);
      if (sourceLabels.has(source) && mediumLabels.has(medium)) candidates.push([source, medium]);
    }
    if (candidates.length !== 1 || archivedLabels) {
      notes.add('Matomo returned an ambiguous or archived source/medium label. Its traffic stays in the unresolved dimensions.');
      continue;
    }
    const [source, medium] = candidates[0]!;
    let children = zero;
    const parent = measuresFor(pair);
    for (const child of table(pair.subtable ?? [])) {
      if (summary(child) || typeof child.label !== 'string' || !child.label) continue;
      const m = measuresFor(child);
      children = combine(children, m);
      namedChildren.set(child.label, combine(namedChildren.get(child.label) ?? zero, m));
      rows.push(row({ source, medium, campaign: child.label }, m, ids));
    }
    const remainder = residual(parent, children, notes);
    if (hasData(remainder)) rows.push(row({ source, medium, campaign: null }, remainder, ids));
    namedTotal = combine(namedTotal, parent);
  }
  for (const name of names) {
    if (summary(name) || typeof name.label !== 'string' || !name.label) continue;
    const m = residual(measuresFor(name), namedChildren.get(name.label) ?? zero, notes);
    if (hasData(m)) rows.push(row({ source: null, medium: null, campaign: name.label }, m, ids));
    namedTotal = combine(namedTotal, m);
  }
  const rest = residual(siteTotal, namedTotal, notes);
  if (hasData(rest)) rows.push(row({ source: null, medium: null, campaign: null }, rest, ids));
  return { rows, sessions: siteTotal.sessions };
}

interface Landing { path: string; urls: Set<string>; visits: number }
async function landingPages(client: MatomoClient, params: Record<string, string>, notes: Set<string>): Promise<Landing[]> {
  const entries = table(await client.call('Actions.getEntryPageUrls', { ...params, flat: '1', showColumns: 'label,url,entry_nb_visits' }));
  const paths = new Map<string, Landing>();
  for (const entry of entries) {
    if (summary(entry) || typeof entry.url !== 'string') { notes.add('Matomo omitted exact URLs for some archived entry pages.'); continue; }
    const url = new URL(entry.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    const path = url.origin + url.pathname;
    const page = paths.get(path) ?? { path, urls: new Set<string>(), visits: 0 };
    page.urls.add(entry.url);
    page.visits += numeric(entry.entry_nb_visits) ?? 0;
    paths.set(path, page);
  }
  return [...paths.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function readAcquisition(client: MatomoClient, site: MatomoSite, q: AcquisitionQuery): Promise<AcquisitionReport> {
  const cursor = q.cursor ?? '0.0';
  if (!/^\d{1,6}\.\d{1,7}$/.test(cursor)) throw new AdportError('INVALID_INPUT', 'Invalid Matomo report cursor.');
  const [bucket, offset] = cursor.split('.').map(Number) as [number, number];
  if (!q.landing_page && bucket !== 0) throw new AdportError('INVALID_INPUT', 'This cursor belongs to a landing-page report.');
  const params = { idSite: site.id, period: q.start_date === q.end_date ? 'day' : 'range',
    date: q.start_date === q.end_date ? q.start_date : q.start_date + ',' + q.end_date,
    filter_limit: String(maxRows + 1), filter_limit_subtable: String(maxRows + 1), format_metrics: '0', language: 'en' };
  const metadata = records(await client.call('API.getReportMetadata', { idSite: site.id, idSites: site.id, apiModule: 'MarketingCampaignsReporting', hideMetricsDoc: '1' }));
  const plugin = metadata.some(r => r.module === 'MarketingCampaignsReporting' && r.action === 'getSourceMedium');
  const notes = new Set<string>();
  if (!plugin) notes.add('This site lacks the Marketing Campaigns Reporting source/medium archive. Campaign names are available; source and medium are unavailable.');
  const pages = q.landing_page ? await landingPages(client, params, notes) : undefined;
  const page = pages?.[bucket];
  const rows: AcquisitionRow[] = [];
  let next: string | undefined;
  if (!pages || page) {
    const segment = page ? [...page.urls].map(url => 'entryPageUrl==' + encodeURIComponent(url)).join(',') : undefined;
    const result = await groups(client, { ...params, ...(segment ? { segment } : {}) }, site, plugin, q.goal_ids ?? [], notes);
    if (page && result.sessions !== page.visits) throw new AdportError('PROVIDER_ERROR', 'Matomo has no matching segmented archive for this entry page. Enable read-time segment archiving or run the report without landing_page.');
    const sorted = result.rows.sort((a, b) => {
      const x = JSON.stringify(a.dimensions), y = JSON.stringify(b.dimensions);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    rows.push(...sorted.slice(offset, offset + q.limit));
    if (page) for (const r of rows) r.dimensions.landing_page = page.path;
    if (offset + rows.length < sorted.length) next = `${bucket}.${offset + rows.length}`;
    else if (pages && bucket + 1 < pages.length) next = `${bucket + 1}.0`;
  }
  return { rows, date_range: { start: q.start_date, end: q.end_date, timezone: site.timezone ?? null }, currency: site.currency ?? null,
    attribution: 'Matomo archived campaign parameters and native conversion attribution. Null dimensions include untagged or unresolved traffic.',
    revenue_basis: site.ecommerce ? 'Recorded ecommerce order revenue in site currency, across all goals.' : 'Recorded converted goal revenue in site currency, across all goals.',
    notes: [...notes], ...(next ? { next_cursor: next } : {}) };
}
