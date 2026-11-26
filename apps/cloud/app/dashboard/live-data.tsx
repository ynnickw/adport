'use client';

import { useEffect, useState } from 'react';
import type { ReportRow } from '@adport/core';
import { Empty, Metric, formatMoney, formatNumber } from '@/components/ui';
import { CampaignTable } from '@/components/campaign-table';
import { LoadingStatus, Notice, SkeletonRows } from '@/components/feedback';
import { Button } from '@/components/controls';
import { Select } from '@/components/select';
import type { DashboardReportSummary } from '@/lib/report-summary';
import { DateRangePicker } from '@/components/date-range-picker';
import Link from 'next/link';
import { ReportCoverage } from '@/components/report-coverage';
import { overviewRangeLabel, overviewRangeParams, type OverviewRange } from '@/lib/overview-range';

interface Summary {
  rows: ReportRow[];
  summary?: DashboardReportSummary;
  truncated?: boolean;
  warnings?: Array<{ provider: string; message: string }>;
}

export function LiveData({ organizationId, connected, initialRange = 'last_7_days' }: { organizationId: string; connected: boolean; initialRange?: OverviewRange }) {
  const [range, setRange] = useState<OverviewRange>(initialRange);
  const rangeQuery = overviewRangeParams(range).toString();
  const [result, setResult] = useState<{ query: string; data: Summary }>();
  const [failure, setFailure] = useState<{ query: string; message: string }>();
  const [attempt, setAttempt] = useState(0);
  const summary = result?.query === rangeQuery ? result.data : undefined;
  const error = failure?.query === rangeQuery ? failure.message : undefined;
  const [groupKey, setGroupKey] = useState('');
  useEffect(() => {
    setFailure(undefined);
    if (!connected) return;
    const controller = new AbortController();
    void fetch(`/api/dashboard/summary?organization_id=${organizationId}&${rangeQuery}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json() as Summary & { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Unable to load campaign data.');
        if (!controller.signal.aborted) setResult({ query: rangeQuery, data: body });
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setFailure({ query: rangeQuery, message: reason instanceof Error ? reason.message : 'Unable to load campaign data.' });
      });
    return () => controller.abort();
  }, [connected, organizationId, rangeQuery, attempt]);

  function changeRange(next: OverviewRange) {
    setRange(next);
    const url = new URL(window.location.href);
    for (const key of ['range', 'from', 'to']) url.searchParams.delete(key);
    overviewRangeParams(next).forEach((value, key) => url.searchParams.set(key, value));
    window.history.replaceState(null, '', url);
  }

  const groups = summary?.summary?.groups ?? [];
  const group = groups.find(item => item.key === groupKey) ?? groups[0];
  const rows = (summary?.rows ?? []).filter(row => !group || (group.currency ? row.currency === group.currency : group.accounts.some(account => account.provider === row.provider && account.account_id === row.accountId)));
  const totals = group?.metrics;
  const loading = connected && !summary && !error;
  const partial = Boolean(summary?.warnings?.length || summary?.truncated || summary?.summary?.complete === false);
  const number = (value: number | null | undefined) => loading ? '…' : value == null ? '—' : formatNumber(value);
  const spend = totals?.spend == null ? '—' : group?.currency ? formatMoney(totals.spend, group.currency) : formatNumber(totals.spend);

  return <>
    {error ? <Notice tone="error">{error}</Notice> : null}
    <div className="performance-toolbar"><DateRangePicker value={range} onChange={changeRange} />
      {groups.length > 1 ? <Select aria-label="Performance currency or account" value={group?.key} onValueChange={setGroupKey} options={groups.map(item => ({ value: item.key, label: item.currency ?? `Unlabelled · ${item.accounts[0]?.account_id ?? 'account'}` }))} /> : group?.currency ? <span className="card-note">{group.currency}</span> : group ? <span className="status warn">Currency unavailable</span> : null}
      <ReportCoverage warnings={summary?.warnings} limited={Boolean(summary?.truncated || (summary?.summary?.complete === false && !summary.warnings?.length))} />
    </div>
    <section className="metrics" aria-label="Performance summary" aria-busy={loading}>
      <Metric label="Spend" value={loading ? '…' : spend} foot="Spend in the selected currency. Unlabelled currencies stay separate by account; no exchange-rate conversion is applied." />
      <Metric label="Clicks" value={number(totals?.clicks)} foot={`${number(totals?.impressions)} impressions in this group. Figures cover ${overviewRangeLabel(range).toLowerCase()}.`} />
      <Metric label="Conversions" value={number(totals?.conversions)} foot="Reported by each advertising platform. Conversion definitions and attribution can differ; this is not a deduplicated customer count." />
      <Metric label="ROAS" value={totals?.roas == null ? loading ? '…' : '—' : `${formatNumber(totals.roas)}×`} foot="Conversion value divided by spend in this currency group. Uses spend-weighted reported ROAS when conversion value is unavailable. A dash means the ratio cannot be calculated." />
    </section>
    <section className="card">
      <div className="card-head"><h2>Campaign activity</h2><div className="report-links"><Link prefetch={false} href={'/dashboard/reports?' + rangeQuery}>Campaign report</Link><Link href="/dashboard/findings">Findings</Link></div></div>
      {loading ? <div className="card-body"><LoadingStatus className="sr-only">Loading campaign activity…</LoadingStatus><SkeletonRows /></div>
        : error ? <div className="empty"><h3>Campaign activity unavailable</h3><Button type="button" className="button secondary small" onClick={() => { setFailure(undefined); setAttempt(current => current + 1); }}>Retry report</Button></div>
        : rows.length === 0 ? <Empty title={partial ? 'No rows from available sources' : 'No campaign activity in this range'} copy={partial ? 'Some data could not be read. Check your connections.' : 'Try a different date range or check that your ad accounts are enabled.'} />
        : <><CampaignTable rows={rows.slice(0, 12)} responsive />{rows.length > 12 ? <div className="table-footnote">{`Showing 12 of ${rows.length} loaded campaigns${group?.currency ? ` in ${group.currency}` : ''}`}</div> : null}</>}
    </section>
  </>;
}
