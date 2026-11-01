import { withSupport } from './website-support.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { providers } from './website-providers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const catalog = JSON.parse(await readFile(resolve(root, 'apps/cloud/lib/cloud/plan-catalog.json'), 'utf8'));
const indexPath = resolve(root, 'website/index.html');
const index = await readFile(indexPath, 'utf8');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const money = value => Number.isInteger(value) ? String(value) : value.toFixed(2);
const copy = {
  reader: ['Explore your accounts', 'Reporting across your connected ad accounts. Start without a card.'],
  operator: ['For owners and small teams', 'Operate your ads with a preview before every change.'],
  premium: ['For growing teams', 'Keep several brands and clients organized in one place.'],
  agency: ['For agencies', 'Coordinate more client accounts and a larger editing team.'],
};
const planIds = ['reader', 'operator', 'premium', 'agency'];
const paidIds = planIds.filter(id => catalog[id].writeAccess);
const providerLogo = id => {
  const svg = index.match(new RegExp(`<svg[^>]*class="${id}-logo"[\\s\\S]*?<\\/svg>`))?.[0];
  if (!svg) throw new Error(`Provider logo missing: ${id}`);
  return svg;
};
const agentLogo = id => {
  const markup = index.match(new RegExp(`<span class="agent agent-${id}">[\\s\\S]*?<\\/svg>`))?.[0];
  if (!markup) throw new Error(`Agent logo missing: ${id}`);
  return markup.slice(markup.indexOf('<svg')).replace(/\s(?:aria-hidden|focusable)="[^"]*"/g, '').replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
};
const icon = id => `<span class="pricing-provider-logo" aria-hidden="true">${providerLogo(id)}</span>`;
const providerStack = (id, planName) => `<div class="provider-stack${planName ? ' provider-stack-card' : ''}" data-provider-tooltip><div class="provider-stack-marks" aria-hidden="true">${providers.slice(0, 4).map(p => icon(p.id)).join('')}</div><button class="provider-more" type="button" aria-label="Show all ${providers.length} ad platforms${planName ? ` included with ${escape(planName)}` : ''}" aria-expanded="false" aria-controls="${id}">+${providers.length - 4}</button><div class="provider-tooltip" id="${id}" role="tooltip" hidden><p>${providers.length} ad platform integrations</p><ul>${providers.map(p => `<li>${icon(p.id)}<span>${escape(p.name)}</span></li>`).join('')}</ul><span class="provider-tooltip-note">Provider access depends on your account and API permissions.</span></div></div>`;
const connectors = () => `<span class="pricing-connector pricing-connector-chatgpt">${agentLogo('chatgpt')}<span>ChatGPT <small>Plugin</small></span></span><span class="pricing-connector pricing-connector-claude">${agentLogo('claude')}<span>Claude <small>Connector</small></span></span><span class="pricing-connector pricing-connector-mcp">${agentLogo('mcp')}<span>Any MCP client <small>Other AI agents</small></span></span>`;
const comparisonIntegrations = `<tbody class="comparison-integrations"><tr><th scope="row">Supported ad platforms</th><td colspan="${planIds.length}"><ul class="comparison-platform-list" aria-label="Included in every plan">${providers.map(p => `<li>${icon(p.id)}<span>${escape(p.name)}</span></li>`).join('')}</ul></td></tr><tr><th scope="row">AI agents &amp; MCP clients</th><td colspan="${planIds.length}"><div class="comparison-connectors">${connectors()}<span class="comparison-included">Included in every plan</span></div></td></tr></tbody>`;
const feature = value => `<span class="comparison-check${value ? '' : ' comparison-no'}" role="img" aria-label="${value ? 'Included' : 'Not included'}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${value ? 'm5 12 4 4L19 6' : 'm7 7 10 10M17 7 7 17'}" /></svg></span>`;
const action = id => `<a class="pricing-action${id === 'premium' ? ' pricing-action-primary' : ''}" href="/#waitlist">Join the waitlist</a>`;
const amount = id => `<div class="pricing-amount"><strong data-monthly="${catalog[id].monthlyPriceEur}" data-annual="${money(catalog[id].annualPriceEur / 12)}">€${catalog[id].monthlyPriceEur}</strong><span>${catalog[id].writeAccess ? '/ month' : 'forever'}</span></div>`;
const billingNote = id => `<p class="pricing-billing-note" data-monthly="${catalog[id].writeAccess ? 'Billed monthly' : 'No card required'}" data-annual="${catalog[id].writeAccess ? `€${catalog[id].annualPriceEur} billed yearly` : 'No card required'}">${catalog[id].writeAccess ? 'Billed monthly' : 'No card required'}</p>`;

const ecosystem = `<div class="pricing-ecosystem">
    <div class="pricing-platforms">${providerStack('pricing-provider-tooltip')}<span>${providers.length} ad platforms</span></div>
    <div class="pricing-connectors" aria-label="AI integrations">${connectors()}</div>
  </div>`;

const comparisonGroups = [
  { name: 'Plan & limits', theme: 'limits', rows: [
    ['Active ad accounts', plan => plan.maxActiveAccounts],
    ['Team members', plan => plan.writeAccess ? `${plan.maxMembers} editors` : `${plan.maxMembers}, read-only`],
    ['Isolated client projects', () => 'Unlimited'],
    ['Read-only client viewers', () => 'Unlimited'],
  ] },
  { name: 'Reporting & connections', theme: 'connections', rows: [
    ['Cross-platform reporting', () => true],
    ['MCP, CLI, REST & dashboard', () => true],
    ['Project-scoped agent connections', () => true],
  ] },
  { name: 'Ad operations', theme: 'operations', rows: [
    ['Read-only tools & account reports', () => true],
    ['Preview and apply ad changes', plan => plan.writeAccess],
    ['Budget caps & protected accounts for writes', plan => plan.writeAccess],
    ['Campaign creation, paused by policy', plan => plan.writeAccess],
  ] },
  { name: 'Audit & collaboration', theme: 'collaboration', rows: [
    ['Audit history', plan => `${plan.maxRetentionDays} days`],
    ['Roles & project permissions', () => true],
    ['Client access without ad changes', () => true],
  ] },
];
function comparison() {
  return `<section class="pricing-comparison" id="compare-plans" aria-labelledby="compare-title"><div class="pricing-heading"><p class="pricing-eyebrow">The details, side by side</p><h2 id="compare-title">Compare plans.</h2><p>Every plan includes unlimited projects and free read-only client viewers.</p></div><p class="comparison-scroll-hint" id="comparison-hint">Scroll to compare all plans.</p><div class="comparison-scroll" role="region" aria-label="Plan feature comparison" aria-describedby="comparison-hint" tabindex="0"><table class="comparison-table"><caption class="sr-only">Adport Cloud features and limits by plan</caption><thead><tr><th scope="col">Features</th>${planIds.map(id => `<th scope="col" class="${id === 'premium' ? 'comparison-featured' : ''}"><span class="comparison-plan">${escape(catalog[id].name)}</span>${amount(id)}${billingNote(id)}${action(id)}</th>`).join('')}</tr></thead>${comparisonIntegrations}${comparisonGroups.map(group => `<tbody><tr class="comparison-group comparison-group-${group.theme}"><th colspan="${planIds.length + 1}" scope="rowgroup"><span>${escape(group.name)}</span></th></tr>${group.rows.map(([label, value]) => `<tr><th scope="row">${escape(label)}</th>${planIds.map(id => { const result = value(catalog[id]); return `<td${id === 'premium' ? ' class="comparison-featured"' : ''}>${typeof result === 'boolean' ? feature(result) : escape(result)}</td>`; }).join('')}</tr>`).join('')}</tbody>`).join('')}</table></div><p class="pricing-shared-note">Operations depend on the connected provider and your account permissions. Ad spend and your AI assistant subscription or model usage are separate.</p></section>`;
}

function pricingSection(standalone = false) {
  const heading = standalone ? 'h1' : 'h2';
  return `<section class="cloud-pricing" id="pricing" aria-labelledby="pricing-title">
  <div class="pricing-heading"><p class="pricing-eyebrow">Adport Cloud pricing</p><${heading} id="pricing-title">One organization. Every client behind the gate.</${heading}><p>Cloud is currently invite-only. Unlimited projects, free read-only client viewers, and fixed pricing with no percentage of ad spend.</p></div>
  ${ecosystem}
  <div class="pricing-billing" aria-label="Billing interval"><button type="button" data-billing="monthly" aria-pressed="true">Monthly</button><button type="button" data-billing="annual" aria-pressed="false">Yearly <span>Save 2 months</span></button></div>
  <div class="pricing-cards">${paidIds.map(id => {
    const plan = catalog[id];
    return `<article class="pricing-card${id === 'premium' ? ' pricing-card-featured' : ''}">
      ${id === 'premium' ? '<span class="pricing-recommended">Recommended</span>' : ''}
      <header class="pricing-card-header"><p class="pricing-eyebrow">${escape(copy[id][0])}</p><h3>${escape(plan.name)}</h3><p class="pricing-description">${escape(copy[id][1])}</p></header>
      <div class="pricing-card-body">${amount(id)}${billingNote(id)}<div class="pricing-limits"><span><strong>${plan.maxActiveAccounts}</strong> active ad accounts</span><span><strong>${plan.maxMembers}</strong> editing members</span></div>
      ${action(id)}<p class="pricing-trial-note">Early access by invitation</p>
      <p class="pricing-list-title">Included with ${escape(plan.name)}</p><ul class="pricing-features">${['Preview and approve ad changes', 'Budget caps & protected accounts', `${plan.maxRetentionDays}-day audit history`, 'Unlimited isolated client projects', 'Free read-only client viewers', 'MCP, CLI, REST & dashboard'].map(text => `<li>${feature(true)}<span>${escape(text)}</span></li>`).join('')}<li class="pricing-platform-feature"><span class="pricing-platform-label">${feature(true)}<span>Ad platforms</span></span>${providerStack(`pricing-${id}-provider-tooltip`, plan.name)}</li><li class="pricing-ai-feature"><span class="pricing-platform-label">${feature(true)}<span>ChatGPT &amp; Claude</span></span><span class="pricing-card-agent-logos" aria-hidden="true"><span class="pricing-card-agent">${agentLogo('chatgpt')}</span><span class="pricing-card-agent pricing-card-agent-claude">${agentLogo('claude')}</span></span></li><li class="pricing-ai-feature"><span class="pricing-platform-label">${feature(true)}<span>Any MCP client</span></span><span class="pricing-card-agent-logos" aria-hidden="true"><span class="pricing-card-agent">${agentLogo('mcp')}</span></span></li></ul></div>
    </article>`;
  }).join('\n')}</div>
  <div class="pricing-free"><div><span class="pricing-free-label">Free</span><h3>Start with a read-only view.</h3><p>${catalog.reader.maxActiveAccounts} active ad accounts · ${catalog.reader.maxMembers} member · ${catalog.reader.maxRetentionDays}-day audit history. Unlimited projects and free read-only client viewers.</p></div><div>${amount('reader')}${action('reader')}<span class="pricing-trial-note">No card required</span></div></div>
  <div class="pricing-next"><a class="pricing-compare-link" href="${standalone ? '#compare-plans' : '/pricing#compare-plans'}">Compare all features <span aria-hidden="true">↓</span></a><a class="pricing-waitlist-link" href="${standalone ? '/#waitlist' : '#waitlist'}">Join the Cloud waitlist <span aria-hidden="true">↗</span></a></div>
  <p class="pricing-shared-note">Prices are per organization. Active accounts and editing members are shared across its projects. Viewers can report, but cannot change ads.</p>
  ${standalone ? comparison() : ''}
  <div class="pricing-enterprise"><div><p class="pricing-eyebrow">Enterprise</p><h3>A little more room for your team.</h3><p>More than ${catalog.agency.maxActiveAccounts} active accounts or ${catalog.agency.maxMembers} editing members? Let’s put together a plan for your organization.</p></div><a class="pricing-action" href="mailto:yannick@adport.dev?subject=Adport%20custom%20plan">Talk to us</a></div>
  <p class="pricing-local">Prefer to host it yourself? The open-source CLI and local MCP server remain free. <a href="https://github.com/ynnickw/adport">Explore the source</a>.</p>
</section>`.replace(/[ \t]+$/gm, '');
}

const section = pricingSection();
const marker = /<!-- pricing:start -->[\s\S]*?<!-- pricing:end -->/;
if (!marker.test(index)) throw new Error('Landing pricing markers are missing.');
const nextIndex = index.replace(marker, `<!-- pricing:start -->\n${section}\n      <!-- pricing:end -->`);
const pageSection = pricingSection(true);
const page = withSupport(`<!doctype html>
<!-- Generated by scripts/website/build-pricing-page.mjs from the shared cloud plan catalog. -->
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Adport pricing | Free, Pro, Growth &amp; Agency</title><meta name="description" content="Adport Cloud starts free. Pro €19, Growth €39, Agency €79 per month. Unlimited projects, free read-only client viewers, and guarded ad management from any AI agent." />
<link rel="canonical" href="https://www.adport.dev/pricing" /><meta property="og:title" content="Adport pricing | Plans for owners, teams &amp; agencies" /><meta property="og:description" content="Fixed pricing, unlimited projects, and free read-only client viewers. Join the Cloud waitlist for early access." /><meta property="og:url" content="https://www.adport.dev/pricing" /><meta property="og:type" content="website" /><meta property="og:image" content="https://www.adport.dev/og-image.png?v=5" />
<link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" /><link rel="preload" href="/fonts/overpass-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin /><link rel="stylesheet" href="/site.css" /><link rel="stylesheet" href="/pricing.css" /><script src="/pricing.js" defer></script></head>
<body class="pricing-page"><a class="skip-link" href="#main">Skip to content</a><header class="site-header"><a class="brand-lockup" href="/" aria-label="Adport home"><span class="domain-wordmark">adport<span aria-hidden="true">.</span>dev</span></a><nav class="header-meta" aria-label="Main navigation"><a href="/#gate">How it works</a><a href="/providers">Integrations</a><a href="/pricing" aria-current="page">Pricing</a><a href="/resources">Resources</a><a class="header-cta" href="/#waitlist">Cloud waitlist</a></nav></header>
<main id="main">${pageSection}<section class="pricing-questions" aria-labelledby="questions-title"><h2 id="questions-title">A few details before you start</h2>
<details><summary>What counts as an active ad account?</summary><p>An ad account with agent access enabled in an organization project uses one account slot. The allowance is shared across all projects. Disable an account to free its slot without deleting its project or audit history.</p></details>
<details><summary>Which people count toward the editing-member allowance?</summary><p>Organization owners, admins, and members with editing access count toward the allowance. Read-only client viewers are free. A person who can edit several projects in the same organization uses one member slot.</p></details>
<details><summary>Does every plan include MCP access?</summary><p>Yes. Connect ChatGPT, Claude, or any MCP-compatible AI client. Every plan includes MCP, CLI, REST, and dashboard access across the available providers. Free is read-only. Paid plans include write tools with the same mandatory preview and approval gate.</p></details>
<details><summary>How does the seven-day trial work?</summary><p>Once you receive Cloud access, your first paid subscription starts a seven-day trial after you add payment details. Returning subscribers can restart without a second trial. Cancel before it ends to avoid the subscription charge. Free requires no card.</p></details>
<details><summary>How does yearly billing work?</summary><p>Pay once for the year: Pro €190, Growth €390, or Agency €790. The monthly equivalent is shown with the full annual charge. This saves two monthly payments compared with paying each month.</p></details>
<details><summary>Does this include ad spend or AI model usage?</summary><p>Ad spend is paid to your advertising platforms. Your AI assistant subscription or model usage is separate. Adport does not charge a percentage of your ad spend.</p></details>
<details><summary>What happens to existing subscriptions?</summary><p>Your subscription keeps its current price until you choose a change in the billing portal. The new account allowances and free read-only viewers apply to the matching plan.</p></details></section></main>
<footer class="site-footer"><span>Adport is operated by Yannick Westermann, trading as Yannick Westermann Labs.</span><nav aria-label="Legal"><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/resources">Resources</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a></nav></footer></body></html>\n`);

const outputs = [[indexPath, nextIndex], [resolve(root, 'website/pricing.html'), page]];
for (const [path, value] of outputs) {
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8').catch(() => '') !== value) throw new Error(`Pricing output is stale: ${path}`);
  } else await writeFile(path, value);
}
console.log(process.argv.includes('--check') ? 'Pricing pages match the cloud catalog.' : 'Generated landing and standalone pricing.');
