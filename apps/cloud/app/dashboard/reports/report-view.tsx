'use client';

import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { ReportRow } from '@adport/core';
import type { ReadResult } from '@/lib/cloud/reads';
import { Empty, PageHeader } from '@/components/ui';
import { Button } from '@/components/controls';
import { ListToolbar, SearchField } from '@/components/list-controls';
import { LoadingStatus, Notice } from '@/components/feedback';
import { CampaignTable } from '@/components/campaign-table';
import { DateRangePicker } from '@/components/date-range-picker';
import { ReportCoverage } from '@/components/report-coverage';
import { Select } from '@/components/select';
import { providerLabel } from '@/lib/cloud/providers';
import { overviewRangeParams, type OverviewRange } from '@/lib/overview-range';

export function CampaignReport({ range, rangeWarning, result }: {
  range: OverviewRange;
  rangeWarning?: string;
  result: ReadResult<{ rows: ReportRow[]; truncated: boolean }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [loading, startLoad] = useTransition();
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const rows = result.ok ? result.data.rows : [];
  const providers = [...new Set(rows.map(row => row.provider))].sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)));
  const platform = providers.includes(provider) ? provider : '';
  const search = query.trim().toLowerCase();
  const visible = rows.filter(row => (!platform || row.provider === platform)
    && [row.entity.name, row.entity.id, row.accountId, providerLabel(row.provider)].some(value => value?.toLowerCase().includes(search)));
  const limited = result.ok && result.data.truncated;

  function changeRange(next: OverviewRange) {
    const nextQuery = overviewRangeParams(next).toString();
    if (overviewRangeParams(range).toString() !== nextQuery || rangeWarning) {
      startLoad(() => router.push(`${pathname}?${nextQuery}`, { scroll: false }));
    }
  }

  return <main className="page">
    <PageHeader title="Campaign report" description="Spend keeps its account currency. Conversion definitions and attribution can differ by platform." />
    {rangeWarning ? <Notice>{rangeWarning}</Notice> : null}
    <div className="performance-toolbar"><DateRangePicker value={range} onChange={changeRange} />
      {loading ? <LoadingStatus>Updating report…</LoadingStatus> : null}
      {!result.ok && !loading ? <Button type="button" className="button secondary small" onClick={() => startLoad(() => router.refresh())}>Retry report</Button> : null}
    </div>
    {!result.ok ? <Notice tone="error">{result.error}</Notice> : null}
    <ReportCoverage warnings={result.warnings} limited={limited} />
    <section className="card" aria-busy={loading}>
      {!rows.length ? <Empty title={!result.ok ? 'Report unavailable' : result.warnings.length ? 'No rows from available sources' : result.connected ? 'No campaign activity in this range' : 'No connected ad platforms'}
        copy={!result.ok || result.warnings.length ? 'Check your platform connections or retry the report.' : result.connected ? 'Try a different date range or check that your ad accounts are enabled.' : 'Connect a platform to see campaign activity.'}
        href={!result.ok || result.warnings.length || !result.connected ? '/dashboard/connections' : undefined}
        action={!result.ok || result.warnings.length ? 'Manage connections' : 'Connect a platform'} /> : <>
        <div className="card-head"><h2>Campaigns</h2><span className="card-note" role="status">{visible.length === rows.length ? `${rows.length} loaded` : `${visible.length} of ${rows.length} loaded`}</span></div>
        <ListToolbar divided>
          <SearchField value={query} onChange={event => setQuery(event.target.value)} aria-label="Search campaigns" placeholder="Find a campaign or account ID" />
          {providers.length > 1 ? <Select aria-label="Platform" options={[{ value: '', label: 'All platforms' }, ...providers.map(id => ({ value: id, label: providerLabel(id) }))]} value={platform} onValueChange={setProvider} /> : null}
        </ListToolbar>
        {visible.length ? <CampaignTable rows={visible} includeImpressions responsive accountPrefix="Account " />
          : <Empty heading="h3" title="No matching campaigns" copy="Try another name, ID, or platform.">
            <Button type="button" className="button secondary small" onClick={() => { setQuery(''); setProvider(''); }}>Clear filters</Button>
          </Empty>}
      </>}
    </section>
  </main>;
}
