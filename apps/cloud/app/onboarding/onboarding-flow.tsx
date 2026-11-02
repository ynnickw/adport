'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Policy } from '@adport/core';
import { Button } from '@/components/controls';
import { BrandLockup } from '@/components/logos';
import { SupportLauncher } from '@/components/support-widget';
import { PendingAccountSelections } from '@/components/pending-account-selections';
import { PolicySummary } from '@/components/policy-summary';
import { isOAuthProvider, type OAuthProvider } from '@/lib/cloud/types';
import { providerLabel } from '@/lib/cloud/providers';
import { ProviderAccountPicker, type ProviderAccountSelection } from '../account-selection/provider-account-picker';
import { AccountAccessManager, type AccountAccessItem } from '../dashboard/accounts/account-access-manager';
import { AssistantConnect, AssistantPicker } from '@/components/assistant-connect';
import type { AssistantConnectionStatus } from '@/lib/cloud/assistant-connection';
import type { AssistantListings } from '@/lib/assistant-listings';
import { AGENT_SETUPS } from '@/lib/agent-setups.mjs';
import { ProviderConnections, type ConnectionView, type OAuthProviderView } from '../dashboard/connections/provider-connections';

type Step = 'welcome' | 'connect' | 'accounts' | 'agent' | 'complete';
const STEPS = [
  { id: 'connect', label: 'Connect a platform', detail: 'Use your existing ad login' },
  { id: 'accounts', label: 'Choose accounts', detail: 'Add and enable the ones you need' },
  { id: 'agent', label: 'Connect your assistant', detail: 'Get your first answer' },
] as const;

export function OnboardingFlow({ organizationId, projectName, policy, setupKind, projectSwitcher, resuming = false, canManage, initialStep, initialAgent, baseUrl, listings, connectedProvider, pendingSelection, accountsSaved = false, accountsEnabled = false, oauthError, providers, connections, accounts, maxActiveAccounts, organizationActiveCount, returnTo }: {
  organizationId: string;
  projectName: string;
  policy: Policy;
  setupKind: 'first_project' | 'new_project';
  projectSwitcher?: React.ReactNode;
  resuming?: boolean;
  canManage: boolean;
  initialStep: Step;
  initialAgent: string | null;
  baseUrl: string;
  listings?: AssistantListings;
  connectedProvider?: string;
  pendingSelection?: ProviderAccountSelection;
  accountsSaved?: boolean;
  accountsEnabled?: boolean;
  oauthError?: string;
  providers: OAuthProviderView[];
  connections: ConnectionView[];
  accounts: AccountAccessItem[];
  maxActiveAccounts: number | null;
  organizationActiveCount: number;
  returnTo: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(accountsEnabled ? 'agent' : connectedProvider ? 'accounts' : initialStep === 'complete' ? 'agent' : initialStep);
  const [agent, setAgent] = useState(initialAgent ?? 'chatgpt');
  const [assistantStatus, setAssistantStatus] = useState<AssistantConnectionStatus>();
  const setupReady = Boolean(assistantStatus?.verified && assistantStatus.hasAccounts);
  const assistantName = AGENT_SETUPS.find(setup => setup.id === agent)?.name ?? 'your assistant';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [providerFilter, setProviderFilter] = useState<OAuthProvider | undefined>(connectedProvider && isOAuthProvider(connectedProvider) ? connectedProvider : undefined);
  const onboardingPath = '/onboarding?' + new URLSearchParams({ return_to: returnTo, ...(resuming ? { resume: '1' } : {}) });
  const connected = connections.some(connection => connection.status === 'connected');
  const hasEnabledAccounts = accounts.some(account => account.enabled && connections.some(connection => connection.provider === account.provider && connection.status === 'connected' && !connection.accountSelectionId));
  const hasPendingSelection = connections.some(connection => connection.status === 'connected' && connection.accountSelectionId);
  const activeIndex = Math.max(0, STEPS.findIndex(item => item.id === step));
  useEffect(() => {
    if (connectedProvider && isOAuthProvider(connectedProvider)) { setStep(accountsEnabled ? 'agent' : 'accounts'); setProviderFilter(connectedProvider); }
  }, [connectedProvider, accountsEnabled]);

  async function advance(next: Step, options: { complete?: boolean; skip?: boolean } = {}) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const response = await fetch('/api/onboarding', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentStep: next, selectedAgent: agent, setupKind, ...options }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) setError(result.error ?? 'Setup could not be saved. Please try again.');
      else if (options.complete || options.skip) { router.push(returnTo); router.refresh(); }
      else {
        if (step === 'accounts' && next !== 'accounts') setProviderFilter(undefined);
        setStep(next);
        window.scrollTo({ top: 0, behavior: 'auto' });
        router.replace(onboardingPath, { scroll: false });
      }
    } catch { setError('Setup could not be saved. Check your connection and try again.'); }
    finally { setBusy(false); }
  }

  const selectingAccounts = step === 'accounts' && Boolean(pendingSelection);
  const skip = () => void advance(step, { skip: true });
  return <>
    <header className="onboarding-head">
      <Link href={returnTo} aria-label="Adport dashboard" onClick={event => { event.preventDefault(); skip(); }}><BrandLockup /></Link>
      <div className="onboarding-project"><span className="setup-project-label">Project</span>{projectSwitcher ?? <span>{projectName}</span>}</div>
      <div className="onboarding-head-actions"><SupportLauncher className="support-inline" /><Button type="button" className="button secondary small" disabled={busy} onClick={skip}>{busy ? 'Saving…' : 'Set up later'}</Button></div>
    </header>
    <div className="onboarding-shell">
      {error ? <div className="error-callout" role="alert">{error}</div> : null}
      {oauthError ? <div className="error-callout" role="alert">{oauthError}</div> : null}
      {step === 'welcome' ? <section className="onboarding-intro">
        <div className="onboarding-intro-copy">
          <span className="plan-kicker">{setupKind === 'new_project' ? 'New project · Included in your plan' : 'Welcome to Adport'}</span>
          <h1>{setupKind === 'new_project' ? <>Set up <span>{projectName}.</span></> : <>Connect your ads.<br />Use the AI you know.</>}</h1>
          <p>{setupKind === 'new_project' ? 'Choose this project’s accounts and connect your assistant. Your organization’s plan and team stay with you.' : 'Get performance insights and manage your campaigns from your AI assistant. Every ad change starts with a preview.'}</p>
          <div className="onboarding-choose-assistant"><h2>Which assistant do you use?</h2><AssistantPicker value={agent} onChange={setAgent} /></div>
          <div className="onboarding-intro-actions"><Button className="button" disabled={busy} onClick={() => void advance('connect')}>Connect a platform <span aria-hidden="true">→</span></Button><Button className="link-button" disabled={busy} onClick={skip}>Explore the dashboard first</Button></div>
          <p className="onboarding-reassurance">Start with one account. Connecting won’t change your campaigns.</p>
        </div>
        <div className="onboarding-roadmap"><span className="plan-kicker">A few steps to your first answer</span><h2>From accounts to answers.</h2><ol>{STEPS.map((item, index) => <li key={item.id}><span>{index + 1}</span><div><strong>{item.label}</strong><p>{item.detail}</p></div></li>)}</ol><div className="onboarding-first-win"><span>Your first question</span><p>“What changed in my ads this week, and what should I look at first?”</p></div></div>
      </section> : <div className="onboarding-workspace">
        <aside className="onboarding-sidebar"><span className="plan-kicker">Project setup</span><h2>{projectName}</h2><nav aria-label="Setup steps"><ol className="onboarding-progress">{STEPS.map((item, index) => {
          const done = item.id === 'connect' ? connected : item.id === 'accounts' ? hasEnabledAccounts : Boolean(assistantStatus?.verified);
          return <li key={item.id} data-active={step === item.id} data-complete={done}><Button type="button" disabled={busy} aria-current={step === item.id ? 'step' : undefined} onClick={() => void advance(item.id)}><span className="onboarding-step-number" aria-hidden="true">{index + 1}</span><span><strong>{item.label}</strong><small>{done ? item.id === 'connect' ? 'Platform connected' : item.id === 'accounts' ? 'Accounts enabled' : 'Read verified' : item.detail}</small></span></Button></li>;
        })}</ol></nav><p className="onboarding-sidebar-note">Only enabled accounts use your plan’s account allowance. Projects are unlimited.</p></aside>
        <div className="onboarding-stage">
          <div className="onboarding-title"><span className="plan-kicker">Step {activeIndex + 1} of 3</span><h1>{step === 'connect' ? 'Where do you run ads?' : step === 'accounts' ? selectingAccounts ? `Choose your ${providerLabel(pendingSelection!.provider)} accounts.` : 'Choose the accounts you need.' : setupReady ? 'Your assistant is ready.' : 'Get your first answer.'}</h1><p>{step === 'connect' ? 'Connect one platform to start. You’ll choose which accounts to add next.' : step === 'accounts' ? selectingAccounts ? `Add and enable the accounts ${assistantName} can use in ${projectName}.` : 'Enabled accounts appear in your reports and are available to your assistant. You can change access anytime.' : setupReady ? <>Read access to <strong>{projectName}</strong> is verified. Finish setup to open your dashboard.</> : <>Connect {assistantName === 'Any MCP client' ? 'your assistant' : assistantName}, then ask a question to verify that everything works.</>}</p></div>
          {step === 'connect' ? <>
            <ProviderConnections variant="onboarding" organizationId={organizationId} canManage={canManage} connections={connections} oauthProviders={providers} returnTo={onboardingPath} />
            <p className="onboarding-reassurance">Your existing campaigns keep running as they are. Every change through Adport requires your approval.</p>
          </> : null}
          {step === 'accounts' ? pendingSelection ? <ProviderAccountPicker organizationId={organizationId} selectionId={pendingSelection.id} provider={pendingSelection.provider} accounts={pendingSelection.accounts} pages={pendingSelection.pages} initialSelectedIds={accounts.filter(account => account.provider === pendingSelection.provider).map(account => account.accountId)} initialEnabledIds={accounts.filter(account => account.provider === pendingSelection.provider && account.enabled).map(account => account.accountId)} maxActiveAccounts={maxActiveAccounts} organizationActiveCount={organizationActiveCount} backHref={onboardingPath + '&step=connect'} nextPath={onboardingPath} /> : <>
            {accountsSaved ? <p className="callout success" role="status">Accounts added. Enable access below when you’re ready.</p> : null}
            <PendingAccountSelections connections={connections} canManage={canManage} setupReturnTo={returnTo} setupResume={resuming} />
            {providerFilter ? <Button className="link-button" onClick={() => setProviderFilter(undefined)}>View all platforms’ accounts</Button> : null}
            {accounts.length || providerFilter ? <AccountAccessManager key={organizationId} organizationId={organizationId} accounts={accounts.map(account => ({ ...account, connectionStatus: connections.find(connection => connection.provider === account.provider)?.status ?? 'revoked', accountSelectionId: connections.find(connection => connection.provider === account.provider)?.accountSelectionId, accountSelectionUnavailable: connections.find(connection => connection.provider === account.provider)?.accountSelectionUnavailable }))} canManage={canManage} maxActiveAccounts={maxActiveAccounts} providerFilter={providerFilter} organizationActiveCount={organizationActiveCount} /> : !hasPendingSelection ? <div className="card"><div className="empty"><h2>Connect a platform to add accounts</h2><p>You can also set up your assistant now and add accounts later.</p><Button className="button secondary" disabled={busy} onClick={() => void advance('connect')}>Connect a platform</Button></div></div> : null}
          </> : null}
          {step === 'agent' ? <>
            <PolicySummary compact policy={policy} settingsHref={'/dashboard/policies?' + new URLSearchParams({ setup: '1', return_to: returnTo })} />
            {!hasEnabledAccounts ? <p className="onboarding-inline-note">You can connect your assistant now. It will see ad data once you enable an account.</p> : null}
            <AssistantConnect baseUrl={baseUrl} projectName={projectName} initialAgent={agent} listings={listings} onSelectionChange={setAgent} onStatusChange={setAssistantStatus} />
          </> : null}
          {!selectingAccounts ? <div className="onboarding-actions">
            <Button className="button secondary" disabled={busy} onClick={() => void advance(step === 'connect' ? 'welcome' : step === 'accounts' ? 'connect' : accounts.length || hasPendingSelection ? 'accounts' : 'connect')}>Back</Button>
            {step === 'connect' && !connected && !accounts.length ? <Button className="link-button" disabled={busy} onClick={() => void advance('agent')}>Set up an assistant instead →</Button> : <Button className="button" disabled={busy || (step === 'agent' && !setupReady)} onClick={() => void advance(step === 'connect' ? accounts.length || hasPendingSelection ? 'accounts' : 'agent' : step === 'accounts' ? 'agent' : 'complete', { complete: step === 'agent' })}>{step === 'agent' ? 'Finish setup' : step === 'connect' ? 'Continue to accounts' : hasEnabledAccounts ? 'Set up my assistant' : accounts.length ? 'Enable access later' : 'Continue without accounts'}</Button>}
          </div> : null}
        </div>
      </div>}
    </div>
  </>;
}
