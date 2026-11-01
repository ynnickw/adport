'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/controls';
import { PendingAccountSelections } from '@/components/pending-account-selections';
import { useRouter } from 'next/navigation';
import { isOAuthProvider, type OAuthProvider } from '@/lib/cloud/types';
import { providerLabel } from '@/lib/cloud/providers';
import { AccountAccessManager, type AccountAccessItem } from '../dashboard/accounts/account-access-manager';
import { AgentSetupGuide } from '../dashboard/agents/agent-setup-guide';
import { ProviderConnections, type ConnectionView, type OAuthProviderView } from '../dashboard/connections/provider-connections';

type Step = 'welcome' | 'connect' | 'accounts' | 'agent' | 'complete';

const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'welcome', label: 'Welcome' }, { id: 'connect', label: 'Platforms' },
  { id: 'accounts', label: 'Account access' }, { id: 'agent', label: 'Assistant' },
];

export function OnboardingFlow({ organizationId, canManage, initialStep, initialAgent, baseUrl, connectedProvider, oauthError, providers, connections, accounts, maxActiveAccounts, organizationActiveCount, returnTo }: {
  organizationId: string;
  canManage: boolean;
  initialStep: Step;
  initialAgent: string | null;
  baseUrl: string;
  connectedProvider?: string;
  oauthError?: string;
  providers: OAuthProviderView[];
  connections: ConnectionView[];
  accounts: AccountAccessItem[];
  maxActiveAccounts: number | null;
  organizationActiveCount: number;
  returnTo: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(connectedProvider ? 'accounts' : initialStep === 'complete' ? 'welcome' : initialStep);
  const [agent, setAgent] = useState(initialAgent ?? 'chatgpt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [providerFilter, setProviderFilter] = useState<OAuthProvider | undefined>(connectedProvider && isOAuthProvider(connectedProvider) ? connectedProvider : undefined);
  const onboardingPath = '/onboarding?return_to=' + encodeURIComponent(returnTo);
  useEffect(() => {
    if (connectedProvider && isOAuthProvider(connectedProvider)) { setStep('accounts'); setProviderFilter(connectedProvider); }
  }, [connectedProvider]);

  async function advance(next: Step, complete = false) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/onboarding', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentStep: next, selectedAgent: next === 'complete' || next === 'agent' ? agent : undefined, complete }),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) setError(result.error ?? 'Setup could not be saved.');
    else if (complete) { router.push(returnTo); router.refresh(); }
    else {
      if (step === 'accounts' && next !== 'accounts') setProviderFilter(undefined);
      setStep(next);
      router.replace(onboardingPath, { scroll: false });
    }
    } catch { setError('Setup could not be saved. Check your connection and try again.'); }
    finally { setBusy(false); }
  }

  const activeIndex = Math.max(0, STEPS.findIndex((item) => item.id === step));
  return (
    <div className="onboarding-shell">
      <ol className="onboarding-progress" aria-label="Setup progress">
        {STEPS.map((item, index) => <li key={item.id} data-active={item.id === step} data-complete={index < activeIndex} aria-current={item.id === step ? 'step' : undefined}><span>{index + 1}</span>{item.label}</li>)}
      </ol>
      {error ? <div className="error-callout" role="alert">{error}</div> : null}
      {oauthError ? <div className="error-callout" role="alert">{oauthError}</div> : null}

      {step === 'welcome' ? <section className="onboarding-hero">
        <span className="plan-kicker">About four minutes</span>
        <h1>Bring your ad accounts into one safe agent workspace.</h1>
        <p>Connect providers, choose exactly which accounts an agent may access, then add Adport to ChatGPT, Codex, Claude, Cursor, or any MCP client.</p>
        <div className="onboarding-points"><span>OAuth credentials stay encrypted</span><span>Every write requires an exact preview</span><span>New campaigns start paused</span></div>
        <Button className="button" disabled={busy} onClick={() => void advance('connect')}>Start setup</Button>
      </section> : null}

      {step === 'connect' ? <section className="onboarding-stage">
        <div className="onboarding-title"><span className="plan-kicker">Step 2 of 4</span><h1>Connect an ad platform</h1><p>Start with one provider. You can add the rest later from Platforms.</p></div>
        <ProviderConnections organizationId={organizationId} canManage={canManage} connections={connections} oauthProviders={providers} returnTo={onboardingPath} />
        <div className="onboarding-actions"><Button className="button secondary" disabled={busy} onClick={() => void advance('welcome')}>Back</Button><Button className="button" disabled={busy} onClick={() => void advance('accounts')}>{connections.some(connection => connection.status === 'connected') ? 'Continue to accounts' : 'Skip platform for now'}</Button></div>
      </section> : null}

      {step === 'accounts' ? <section className="onboarding-stage">
        <div className="onboarding-title"><span className="plan-kicker">Step 3 of 4</span><h1>{providerFilter ? `Enable ${providerLabel(providerFilter)} account access` : 'Enable account access'}</h1><p>Turn on access for the accounts you want to use in reports and with your assistant.</p></div>
        <PendingAccountSelections connections={connections} canManage={canManage} setupReturnTo={returnTo} />
        {providerFilter ? <Button className="button secondary small" onClick={() => setProviderFilter(undefined)}>View all providers’ accounts</Button> : null}
        {accounts.length || providerFilter ? <AccountAccessManager key={organizationId} organizationId={organizationId} accounts={accounts.map(account => ({ ...account, connectionStatus: connections.find(connection => connection.provider === account.provider)?.status ?? 'revoked', accountSelectionId: connections.find(connection => connection.provider === account.provider)?.accountSelectionId, accountSelectionUnavailable: connections.find(connection => connection.provider === account.provider)?.accountSelectionUnavailable }))} canManage={canManage} maxActiveAccounts={maxActiveAccounts} providerFilter={providerFilter} organizationActiveCount={organizationActiveCount} /> : <div className="card"><div className="empty"><h2>No accounts added yet</h2><p>Go back to connect a platform, or add accounts later from the dashboard.</p></div></div>}
        <div className="onboarding-actions"><Button className="button secondary" disabled={busy} onClick={() => void advance('connect')}>Back</Button><Button className="button" disabled={busy} onClick={() => void advance('agent')}>{accounts.some(account => account.enabled) ? 'Connect an assistant' : 'Continue without account access'}</Button></div>
      </section> : null}

      {step === 'agent' ? <section className="onboarding-stage">
        <div className="onboarding-title"><span className="plan-kicker">Step 4 of 4</span><h1>Add Adport to your agent</h1><p>Choose your client, copy its setup, and finish the secure workspace authorization in your browser.</p></div>
        <AgentSetupGuide baseUrl={baseUrl} initialSelectedId={agent} onSelectionChange={setAgent} />
        <div className="onboarding-actions"><Button className="button secondary" disabled={busy} onClick={() => void advance('accounts')}>Back</Button><Button className="button" disabled={busy} onClick={() => void advance('complete', true)}>{busy ? 'Finishing…' : 'Open dashboard'}</Button></div>
      </section> : null}
    </div>
  );
}
