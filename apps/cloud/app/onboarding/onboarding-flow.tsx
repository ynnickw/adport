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
import { ProviderAccountPicker, AccountConnectionProgress, type ProviderAccountSelection } from '../account-selection/provider-account-picker';
import { AccountAccessManager, type AccountAccessItem } from '../dashboard/accounts/account-access-manager';
import { AgentSetupGuide } from '../dashboard/agents/agent-setup-guide';
import { ProviderConnections, type ConnectionView, type OAuthProviderView } from '../dashboard/connections/provider-connections';

type Step = 'welcome' | 'connect' | 'accounts' | 'agent' | 'complete';
const STEPS = [
  { id: 'connect', label: 'Connect a platform', detail: 'Use your existing ad login' },
  { id: 'accounts', label: 'Add your accounts', detail: 'Choose accounts and enable access' },
  { id: 'agent', label: 'Add your assistant', detail: 'Use the AI you already know' },
] as const;

export function OnboardingFlow({ organizationId, projectName, policy, setupKind, projectSwitcher, resuming = false, canManage, initialStep, initialAgent, baseUrl, connectedProvider, pendingSelection, accountsSaved = false, oauthError, providers, connections, accounts, maxActiveAccounts, organizationActiveCount, returnTo }: {
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
  connectedProvider?: string;
  pendingSelection?: ProviderAccountSelection;
  accountsSaved?: boolean;
  oauthError?: string;
  providers: OAuthProviderView[];
  connections: ConnectionView[];
  accounts: AccountAccessItem[];
  maxActiveAccounts: number | null;
  organizationActiveCount: number;
  returnTo: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(connectedProvider ? 'accounts' : initialStep === 'complete' ? 'connect' : initialStep);
  const [agent, setAgent] = useState(initialAgent ?? 'chatgpt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [providerFilter, setProviderFilter] = useState<OAuthProvider | undefined>(connectedProvider && isOAuthProvider(connectedProvider) ? connectedProvider : undefined);
  const onboardingPath = '/onboarding?' + new URLSearchParams({ return_to: returnTo, ...(resuming ? { resume: '1' } : {}) });
  const connected = connections.some(connection => connection.status === 'connected');
  const hasEnabledAccounts = accounts.some(account => account.enabled && connections.some(connection => connection.provider === account.provider && connection.status === 'connected' && !connection.accountSelectionId));
  const hasPendingSelection = connections.some(connection => connection.status === 'connected' && connection.accountSelectionId);
  const activeIndex = Math.max(0, STEPS.findIndex(item => item.id === step));
  useEffect(() => {
    if (connectedProvider && isOAuthProvider(connectedProvider)) { setStep('accounts'); setProviderFilter(connectedProvider); }
  }, [connectedProvider]);

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
      <div className="onboarding-project">{projectSwitcher ?? <span>{projectName}</span>}</div>
      <div className="onboarding-head-actions"><SupportLauncher className="support-inline" /><Button type="button" className="button secondary small" disabled={busy} onClick={skip}>{busy ? 'Saving…' : 'Set up later'}</Button></div>
    </header>
    <div className="onboarding-shell">
      {error ? <div className="error-callout" role="alert">{error}</div> : null}
      {oauthError ? <div className="error-callout" role="alert">{oauthError}</div> : null}
      {step === 'welcome' ? <section className="onboarding-intro">
        <div className="onboarding-intro-copy">
          <span className="plan-kicker">{setupKind === 'new_project' ? 'New project · Included in your plan' : 'Welcome to Adport'}</span>
          <h1>{setupKind === 'new_project' ? <>Set up <span>{projectName}.</span></> : <>Your ads.<br />One clear picture.</>}</h1>
          <p>{setupKind === 'new_project' ? 'Keep this client’s accounts, reports, and AI access in their own space. Your organization’s plan and team stay with you.' : 'See how your campaigns are doing, find what needs attention, and work on your ads with your AI assistant.'}</p>
          <div className="onboarding-intro-actions"><Button className="button" disabled={busy} onClick={() => void advance('connect')}>Connect a platform <span aria-hidden="true">→</span></Button><Button className="link-button" disabled={busy} onClick={skip}>Explore the dashboard first</Button></div>
          <p className="onboarding-reassurance">Start with one account. Connecting won’t change your campaigns.</p>
        </div>
        <div className="onboarding-roadmap"><span className="plan-kicker">A few steps to your first answer</span><h2>From accounts to answers.</h2><ol>{STEPS.map((item, index) => <li key={item.id}><span>{index + 1}</span><div><strong>{item.label}</strong><p>{item.detail}</p></div></li>)}</ol><div className="onboarding-first-win"><span>Your first question</span><p>“What changed in my ads this week, and what should I look at first?”</p></div></div>
      </section> : <div className="onboarding-workspace">
        <aside className="onboarding-sidebar"><span className="plan-kicker">Project setup</span><h2>{projectName}</h2><nav aria-label="Setup steps"><ol className="onboarding-progress">{STEPS.map((item, index) => {
          const done = item.id === 'connect' ? connected : item.id === 'accounts' ? hasEnabledAccounts : false;
          return <li key={item.id} data-active={step === item.id} data-complete={done}><Button type="button" disabled={busy} aria-current={step === item.id ? 'step' : undefined} onClick={() => void advance(item.id)}><span className="onboarding-step-number" aria-hidden="true">{done ? '✓' : index + 1}</span><span><strong>{item.label}</strong><small>{done ? item.id === 'connect' ? 'Platform connected' : 'Accounts enabled' : item.detail}</small></span></Button></li>;
        })}</ol></nav><p className="onboarding-sidebar-note">Only enabled accounts use your plan’s account allowance. Projects are unlimited.</p></aside>
        <div className="onboarding-stage">
          <div className="onboarding-title"><span className="plan-kicker">Step {activeIndex + 1} of 3</span><h1>{step === 'connect' ? 'Where do you run ads?' : step === 'accounts' ? selectingAccounts ? `Choose your ${providerLabel(pendingSelection!.provider)} accounts.` : 'Enable the accounts you need.' : 'Connect your AI assistant.'}</h1><p>{step === 'connect' ? 'Connect one platform to start. You’ll choose which accounts to add next.' : step === 'accounts' ? selectingAccounts ? `Choose the accounts to add to ${projectName}. You’ll enable assistant access next.` : 'Enabled accounts appear in your reports and are available to your assistant. You can change access anytime.' : <>Choose your assistant below. When Adport asks which project to authorize, select <strong>{projectName}</strong>.</>}</p></div>
          {step === 'connect' ? <>
            <ProviderConnections variant="onboarding" organizationId={organizationId} canManage={canManage} connections={connections} oauthProviders={providers} returnTo={onboardingPath} />
            <p className="onboarding-reassurance">Your existing campaigns keep running as they are. Every change through Adport requires your approval.</p>
          </> : null}
          {step === 'accounts' ? pendingSelection ? <ProviderAccountPicker organizationId={organizationId} selectionId={pendingSelection.id} provider={pendingSelection.provider} accounts={pendingSelection.accounts} pages={pendingSelection.pages} initialSelectedIds={accounts.filter(account => account.provider === pendingSelection.provider).map(account => account.accountId)} backHref={onboardingPath + '&step=connect'} nextPath={onboardingPath} /> : <>
            {accountsSaved ? <AccountConnectionProgress stage="enable" /> : null}
            <PendingAccountSelections connections={connections} canManage={canManage} setupReturnTo={returnTo} setupResume={resuming} />
            {providerFilter ? <Button className="link-button" onClick={() => setProviderFilter(undefined)}>View all platforms’ accounts</Button> : null}
            {accounts.length || providerFilter ? <AccountAccessManager key={organizationId} organizationId={organizationId} accounts={accounts.map(account => ({ ...account, connectionStatus: connections.find(connection => connection.provider === account.provider)?.status ?? 'revoked', accountSelectionId: connections.find(connection => connection.provider === account.provider)?.accountSelectionId, accountSelectionUnavailable: connections.find(connection => connection.provider === account.provider)?.accountSelectionUnavailable }))} canManage={canManage} maxActiveAccounts={maxActiveAccounts} providerFilter={providerFilter} organizationActiveCount={organizationActiveCount} /> : !hasPendingSelection ? <div className="card"><div className="empty"><h2>Connect a platform to add accounts</h2><p>You can also set up your assistant now and add accounts later.</p><Button className="button secondary" disabled={busy} onClick={() => void advance('connect')}>Connect a platform</Button></div></div> : null}
          </> : null}
          {step === 'agent' ? <>
            <PolicySummary policy={policy} settingsHref={'/dashboard/policies?' + new URLSearchParams({ setup: '1', return_to: returnTo })} />
            {!hasEnabledAccounts ? <p className="onboarding-inline-note">You can connect your assistant now. It will see ad data once you enable an account.</p> : null}
            <AgentSetupGuide variant="onboarding" baseUrl={baseUrl} projectName={projectName} initialSelectedId={agent} onSelectionChange={setAgent} />
          </> : null}
          {!selectingAccounts ? <div className="onboarding-actions">
            <Button className="button secondary" disabled={busy} onClick={() => void advance(step === 'connect' ? 'welcome' : step === 'accounts' ? 'connect' : accounts.length || hasPendingSelection ? 'accounts' : 'connect')}>Back</Button>
            {step === 'connect' && !connected && !accounts.length ? <Button className="link-button" disabled={busy} onClick={() => void advance('agent')}>Set up an assistant instead →</Button> : <Button className="button" disabled={busy} onClick={() => void advance(step === 'connect' ? accounts.length || hasPendingSelection ? 'accounts' : 'agent' : step === 'accounts' ? 'agent' : 'complete', { complete: step === 'agent' })}>{step === 'agent' ? 'Open dashboard' : step === 'connect' ? 'Continue to accounts' : hasEnabledAccounts ? 'Set up my assistant' : accounts.length ? 'Enable access later' : 'Continue without accounts'}</Button>}
          </div> : null}
        </div>
      </div>}
    </div>
  </>;
}
