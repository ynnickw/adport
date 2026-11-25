'use client';

import { useState } from 'react';
import type { AuditFinding } from '@adport/core';
import { Button, Disclosure } from '@/components/controls';
import { FilterButtons } from '@/components/list-controls';
import { DataCell, DataTable } from '@/components/data-table';
import { Empty, Provider } from '@/components/ui';

const Severity = {
  critical: { label: 'Critical', tone: 'critical', rank: 0 },
  warn: { label: 'Warning', tone: 'warn', rank: 1 },
  info: { label: 'Info', tone: 'neutral', rank: 2 },
} as const;
const statusLabels = { open: 'Open', dismissed: 'Dismissed', applied: 'Applied' } as const;

type FindingRow = Pick<AuditFinding, 'id' | 'title' | 'detail' | 'recommendation' | 'severity' | 'provider' | 'accountId' | 'entity' | 'status' | 'updatedAt'> & { updatedLabel: string };

export function FindingsTable({ findings }: { findings: FindingRow[] }) {
  const [view, setView] = useState<'open' | 'resolved' | 'all'>('open');
  const open = findings.filter(finding => finding.status === 'open').length;
  const visible = findings.filter(finding => view === 'all' || (finding.status === 'open') === (view === 'open'))
    .sort((a, b) => (view === 'open' ? Severity[a.severity].rank - Severity[b.severity].rank : 0) || b.updatedAt.localeCompare(a.updatedAt));
  return <>
    <div className="card-head"><h2>Audit findings</h2></div>
    <FilterButtons className="connection-filters" label="Filter findings" value={view} onChange={setView}
      options={([['open', 'Open', open], ['resolved', 'Resolved', findings.length - open], ['all', 'All', findings.length]] as const)
        .map(([value, label, count]) => ({ value, label, count }))} />
    {visible.length ? <DataTable responsive columns={['Severity', 'Finding', 'Platform', 'Status', 'Updated']}>
      {visible.map(finding => <tr key={finding.id}>
        <DataCell label="Severity"><span className={`status ${Severity[finding.severity].tone}`}>{Severity[finding.severity].label}</span></DataCell>
        <DataCell label="Finding"><strong>{finding.title}</strong><div className="cell-sub">{finding.entity.name || finding.entity.id}</div>
          <Disclosure className="history-details finding-details" label="Details">
            {finding.detail ? <p>{finding.detail}</p> : null}<p><strong>Recommendation</strong><br />{finding.recommendation}</p>
          </Disclosure>
        </DataCell>
        <DataCell label="Platform"><Provider name={finding.provider} /><div className="cell-sub">{finding.accountId}</div></DataCell>
        <DataCell label="Status"><span className={`status ${finding.status === 'open' ? 'warn' : 'neutral'}`}>{statusLabels[finding.status]}</span></DataCell>
        <DataCell label="Updated"><time dateTime={finding.updatedAt}>{finding.updatedLabel}</time></DataCell>
      </tr>)}
    </DataTable> : <Empty heading="h3" title={view === 'open' ? 'No open findings' : 'No resolved findings'}
      copy={view === 'open' ? 'Nothing needs attention from the latest audits.' : 'Applied and dismissed findings will appear here.'}>
      <Button className="button secondary small" type="button" onClick={() => setView('all')}>View all findings</Button>
    </Empty>}
  </>;
}
