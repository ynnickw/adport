import catalog from '@/lib/cloud/plan-catalog.json';
import type { UpgradePlanId } from '@/lib/cloud/plan-limit';
import { ProviderLogo } from './logos';
import { AgentIdentityLogo } from '@/app/dashboard/agents/agent-setup-guide';
import { InfoTooltip } from './info-tooltip';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';
import { providerLabel } from '@/lib/cloud/providers';

const COPY = {
  operator: ['For owners and small teams', 'Operate your ads with a preview before every change.'],
  premium: ['For growing teams', 'Keep brands, departments, and projects organized in one place.'],
  agency: ['For larger teams', 'Coordinate more accounts and people across your organization.'],
  enterprise: ['For your organization', 'More room for your accounts, team, and audit history.'],
};

function Check() { return <span className="comparison-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg></span>; }

export function PlanCard({ planId, interval = 'monthly', badge, featured = false, compact = false, action, note }: {
  planId: UpgradePlanId; interval?: 'monthly' | 'annual'; badge?: string; featured?: boolean; compact?: boolean;
  action?: React.ReactNode; note?: React.ReactNode;
}) {
  const plan = catalog[planId];
  const price = interval === 'annual' && plan.annualPriceEur !== null ? (plan.annualPriceEur / 12).toFixed(2) : plan.monthlyPriceEur;
  const features = compact ? [`${plan.maxRetentionDays}-day audit history`, 'Preview and approve ad changes', 'Unlimited projects and free viewers']
    : ['Preview and approve ad changes', 'Budget caps & protected accounts', `${plan.maxRetentionDays}-day audit history`, 'Unlimited isolated projects', 'Free read-only viewers', 'MCP, CLI, REST & dashboard'];
  return <article className={`pricing-surface pricing-card${featured ? ' pricing-card-featured' : ''}${compact ? ' pricing-card-compact' : ''}`} aria-label={`${plan.name} plan`}>
    {badge ? <span className="pricing-recommended">{badge}</span> : null}
    <header className="pricing-card-header"><p className="pricing-eyebrow">{COPY[planId]![0]}</p><h3>{plan.name}</h3>{!compact ? <p className="pricing-description">{COPY[planId]![1]}</p> : null}</header>
    <div className="pricing-card-body">
      <div className="pricing-amount">{price === null ? <strong className="pricing-custom-amount">Let’s talk</strong> : <><strong>€{price}</strong><span>/ month</span></>}</div>
      <p className="pricing-billing-note">{price === null ? 'A plan tailored to your organization' : interval === 'annual' ? `€${plan.annualPriceEur} billed yearly` : 'Billed monthly'}</p>
      <div className="pricing-limits"><span><strong>{plan.maxActiveAccounts ?? 'Unlimited'}</strong> active ad accounts</span><span><strong>{plan.maxMembers ?? 'Unlimited'}</strong> editing members</span></div>
      {action ? <div className="pricing-card-action">{action}</div> : null}{note ? <div className="pricing-trial-note">{note}</div> : null}
      {!compact ? <p className="pricing-list-title">Included with {plan.name}</p> : null}
      <ul className="pricing-features">{features.map(feature => <li key={feature}><Check /><span>{feature}</span></li>)}
        {!compact ? <>
          <li className="pricing-platform-feature"><span className="pricing-platform-label"><Check /><span>Ad platforms</span></span><span className="dashboard-provider-stack">{OAUTH_PROVIDERS.slice(0, 4).map(provider => <span className="pricing-provider-logo" key={provider}><ProviderLogo name={provider} /></span>)}<InfoTooltip label="Included ad platforms">{OAUTH_PROVIDERS.map(providerLabel).join(', ')}. Provider access depends on your account and API permissions.</InfoTooltip></span></li>
          <li className="pricing-ai-feature"><span className="pricing-platform-label"><Check /><span>ChatGPT &amp; Claude</span></span><span className="pricing-card-agent-logos"><AgentIdentityLogo name="ChatGPT" /><AgentIdentityLogo name="Claude" /></span></li>
          <li className="pricing-ai-feature"><span className="pricing-platform-label"><Check /><span>Any MCP client</span></span><AgentIdentityLogo name="Any MCP client" /></li>
        </> : null}
      </ul>
    </div>
  </article>;
}
