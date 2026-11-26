import { overviewRangeFromParams, type OverviewRange } from '@/lib/overview-range';

export function parseCampaignRange(params: { range?: string; from?: string; to?: string }): { range: OverviewRange; warning?: string } {
  const query = new URLSearchParams();
  for (const key of ['range', 'from', 'to'] as const) {
    if (typeof params[key] === 'string') query.set(key, params[key]);
  }
  if (!query.has('range')) return { range: 'last_30_days' };
  try {
    return { range: overviewRangeFromParams(query) };
  } catch {
    return { range: 'last_30_days', warning: 'That date range isn’t valid. Showing the last 30 days.' };
  }
}
