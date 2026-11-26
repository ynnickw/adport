import type { ReportRow } from '@adport/core';
import { DataCell, DataTable } from './data-table';
import { Provider, formatMoney, formatNumber } from './ui';

const metrics = [
  { key: 'spend', label: 'Spend', short: 'Spend' },
  { key: 'impressions', label: 'Impressions', short: 'Impr.' },
  { key: 'clicks', label: 'Clicks', short: 'Clicks' },
  { key: 'conversions', label: 'Conversions', short: 'Conv.' },
  { key: 'roas', label: 'ROAS', short: 'ROAS' },
] as const;

export function CampaignTable({ rows, includeImpressions = false, responsive = false, accountPrefix = '' }: {
  rows: ReportRow[]; includeImpressions?: boolean; responsive?: boolean; accountPrefix?: string;
}) {
  const displayed = includeImpressions ? metrics : metrics.filter(metric => metric.key !== 'impressions');
  return <DataTable responsive={responsive} className="campaign-report-table" columns={[
    'Campaign', 'Platform', 'Status',
    ...displayed.map(({ key, short, label }) => ({ id: key, label: short === label ? short : <abbr title={label}>{short}</abbr>, align: 'end' as const })),
  ]}>
    {rows.map(row => <tr key={`${row.provider}:${row.accountId}:${row.entity.id}`}>
      <DataCell label="Campaign" className="campaign-name"><strong>{row.entity.name || row.entity.id}</strong><div className="cell-sub">{accountPrefix}{row.accountId}</div></DataCell>
      <DataCell label="Platform" className="campaign-platform"><Provider name={row.provider} /></DataCell>
      <DataCell label="Status" className="campaign-status">{row.entity.status ? <span className={`status ${/paused|disabled|removed/i.test(row.entity.status) ? 'neutral' : ''}`}>{row.entity.status}</span> : '—'}</DataCell>
      {displayed.map(({ key, label }) => {
        const value = row.metrics[key];
        return <DataCell key={key} label={label} numeric>{value == null ? '—'
          : key === 'spend' ? row.currency ? formatMoney(value, row.currency) : <span>{formatNumber(value)}<span className="cell-sub">Currency unavailable</span></span>
          : key === 'roas' ? `${formatNumber(value)}×` : formatNumber(value)}</DataCell>;
      })}
    </tr>)}
  </DataTable>;
}
