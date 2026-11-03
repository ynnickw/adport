import catalog from '@/lib/cloud/plan-catalog.json';
import type { PlanDefinition } from '@/lib/cloud/plans';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';
import { providerLabel } from '@/lib/cloud/providers';
import { ProviderLogo } from './logos';
import { PricingConnectors } from './pricing-integrations';

const PLAN_IDS = ['reader', 'operator', 'premium', 'agency'] as const;
const GROUPS: Array<{ name: string; theme: string; rows: Array<[string, (plan: Omit<PlanDefinition, 'id'>) => string | number | boolean | null]> }> = [
  { name: 'Plan & limits', theme: 'limits', rows: [['Active ad accounts', plan => plan.maxActiveAccounts], ['Team members', plan => plan.writeAccess ? `${plan.maxMembers} editors` : `${plan.maxMembers}, read-only`], ['Isolated projects', () => 'Unlimited'], ['Read-only viewers', () => 'Unlimited']] },
  { name: 'Reporting & connections', theme: 'connections', rows: [['Cross-platform reporting', () => true], ['MCP, CLI, REST & dashboard', () => true], ['Project-scoped agent connections', () => true]] },
  { name: 'Ad operations', theme: 'operations', rows: [['Read-only tools & account reports', () => true], ['Preview and apply ad changes', plan => plan.writeAccess], ['Budget caps & protected accounts for writes', plan => plan.writeAccess], ['Campaign creation, paused by policy', plan => plan.writeAccess]] },
  { name: 'Audit & collaboration', theme: 'collaboration', rows: [['Audit history', plan => `${plan.maxRetentionDays} days`], ['Roles & project permissions', () => true], ['Read-only access without ad changes', () => true]] },
];
function Included({ value }: { value: boolean }) { return <span className={`comparison-check${value ? '' : ' comparison-no'}`} role="img" aria-label={value ? 'Included' : 'Not included'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={value ? 'm5 12 4 4L19 6' : 'm7 7 10 10M17 7 7 17'} /></svg></span>; }

export function PricingFeatureTable({ idPrefix, interval, actions }: { idPrefix: string; interval: 'monthly' | 'annual'; actions: Partial<Record<typeof PLAN_IDS[number], React.ReactNode>> }) {
  return <section className="pricing-comparison" id={`${idPrefix}-compare-plans`} aria-labelledby={`${idPrefix}-compare-title`}>
    <div className="pricing-heading"><p className="pricing-eyebrow">The details, side by side</p><h2 id={`${idPrefix}-compare-title`}>Compare plans.</h2><p>Every plan includes unlimited projects and free read-only viewers.</p></div>
    <p className="comparison-scroll-hint" id={`${idPrefix}-comparison-hint`}>Scroll to compare all plans.</p>
    <div className="comparison-scroll" role="region" aria-label="Plan feature comparison" aria-describedby={`${idPrefix}-comparison-hint`} tabIndex={0}><table className="comparison-table"><caption className="sr-only">Adport Cloud features and limits by plan</caption>
      <thead><tr><th scope="col">Features</th>{PLAN_IDS.map(id => { const plan = catalog[id]; return <th scope="col" className={id === 'premium' ? 'comparison-featured' : undefined} key={id}><span className="comparison-plan">{plan.name}</span><div className="pricing-amount"><strong>€{interval === 'annual' && plan.writeAccess ? (plan.annualPriceEur / 12).toFixed(2) : plan.monthlyPriceEur}</strong><span>{plan.writeAccess ? '/ month' : 'forever'}</span></div><p className="pricing-billing-note">{!plan.writeAccess ? 'No card required' : interval === 'annual' ? `€${plan.annualPriceEur} billed yearly` : 'Billed monthly'}</p>{actions[id]}</th>; })}</tr></thead>
      <tbody className="comparison-integrations"><tr><th scope="row">Supported ad platforms</th><td colSpan={PLAN_IDS.length}><ul className="comparison-platform-list" aria-label="Included in every plan">{OAUTH_PROVIDERS.map(provider => <li key={provider}><span className="pricing-provider-logo" aria-hidden="true"><ProviderLogo name={provider} /></span><span>{providerLabel(provider)}</span></li>)}</ul></td></tr><tr><th scope="row">AI agents &amp; MCP clients</th><td colSpan={PLAN_IDS.length}><div className="comparison-connectors"><PricingConnectors /><span className="comparison-included">Included in every plan</span></div></td></tr></tbody>
      {GROUPS.map(group => <tbody key={group.theme}><tr className={`comparison-group comparison-group-${group.theme}`}><th colSpan={PLAN_IDS.length + 1} scope="rowgroup"><span>{group.name}</span></th></tr>{group.rows.map(([label, value]) => <tr key={label}><th scope="row">{label}</th>{PLAN_IDS.map(id => { const result = value(catalog[id]); return <td key={id} className={id === 'premium' ? 'comparison-featured' : undefined}>{typeof result === 'boolean' ? <Included value={result} /> : result}</td>; })}</tr>)}</tbody>)}
    </table></div><p className="pricing-shared-note">Operations depend on the connected provider and your account permissions. Ad spend and your AI assistant subscription or model usage are separate.</p>
  </section>;
}
