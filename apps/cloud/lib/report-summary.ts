export interface DashboardReportSummary {
  complete: boolean;
  groups: Array<{
    key: string;
    currency: string | null;
    accounts: Array<{ provider: string; account_id: string }>;
    metrics: Record<'spend' | 'impressions' | 'clicks' | 'conversions' | 'conversion_value' | 'roas', number | null>;
  }>;
}
