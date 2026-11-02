import Link from 'next/link';
import type { Policy } from '@adport/core';
import { InfoTooltip } from './info-tooltip';

export function PolicySummary({ policy, settingsHref, compact = false }: { policy: Policy; settingsHref: string; compact?: boolean }) {
  if (compact) return <section className="setup-safety" aria-label="Project safeguards"><span><strong>Preview required for every ad change</strong> <InfoTooltip label="About your project safeguards">Always on. Each change needs its exact preview token and arguments. Saved optional rules: new campaigns and ads {policy.paused_creation ? 'start paused' : 'use the requested status'}; budget changes {policy.max_budget_delta_pct === null ? 'have no percentage limit' : `are limited to ${policy.max_budget_delta_pct}%`}; daily budgets {policy.max_daily_budget_micros === null ? 'have no limit' : `are limited to ${new Intl.NumberFormat('en', { maximumFractionDigits: 6 }).format(policy.max_daily_budget_micros / 1_000_000)} in each account’s currency`}. {new Set(policy.protected_accounts).size} read-only accounts. Previews expire after {policy.pending_ttl_minutes} minutes.</InfoTooltip></span><Link href={settingsHref}>Safety settings</Link></section>;
  return <section className="policy-summary" aria-label="Project safeguards">
    <div className="policy-summary-head"><h2>Project safeguards <InfoTooltip label="About project safeguards">These are the saved settings for this project. Previews expire after {policy.pending_ttl_minutes} minutes. You can change the optional safeguards in Policies.</InfoTooltip></h2><Link href={settingsHref} className="link-button">Customize</Link></div>
    <dl>
      <div><dt>Ad changes</dt><dd>Preview required <InfoTooltip label="About the preview gate">Always on. Applying an advertising change requires the exact arguments and token from its preview. Changing the safety policy requires a new preview.</InfoTooltip></dd></div>
      <div><dt>New campaigns &amp; ads</dt><dd>{policy.paused_creation ? 'Start paused' : 'Use requested status'}</dd></div>
      <div><dt>Budget change limit <InfoTooltip label="About the budget change summary">Applies to both increases and decreases in one operation when the current budget is known.</InfoTooltip></dt><dd>{policy.max_budget_delta_pct === null ? 'No limit' : `${policy.max_budget_delta_pct}%`}</dd></div>
      <div><dt>Daily budget limit <InfoTooltip label="About the daily budget summary">Applies to each daily budget in its ad account’s currency. This is not a total account spend cap.</InfoTooltip></dt><dd>{policy.max_daily_budget_micros === null ? 'No limit' : new Intl.NumberFormat('en', { maximumFractionDigits: 6 }).format(policy.max_daily_budget_micros / 1_000_000)}</dd></div>
      {policy.protected_accounts.length ? <div><dt>Read-only accounts</dt><dd>{new Set(policy.protected_accounts).size}</dd></div> : null}
    </dl>
  </section>;
}
