'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AccountAccessManager, type AccountAccessItem } from '../dashboard/accounts/account-access-manager';
import { AgentSetupGuide } from '../dashboard/agents/agent-setup-guide';
import { ProviderConnections, type ConnectionView, type OAuthProviderView } from '../dashboard/connections/provider-connections';

type Step = 'welcome' | 'connect' | 'accounts' | 'agent' | 'complete';

const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'welcome', label: 'Welcome' }, { id: 'connect', label: 'Platforms' },
  { id: 'accounts', label: 'Accounts' }, { id: 'agent', label: 'Agent' },
];

export function OnboardingFlow({ organizationId, canManage, initialStep, initialAgent, baseUrl, connectedProvider, oauthError, providers, connections, accounts, maxActiveAccounts }: {
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
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(connectedProvider ? 'accounts' : initialStep === 'complete' ? 'welcome' : initialStep);
  const [agent, setAgent] = useState(initialAgent ?? 'chatgpt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function advance(next: Step, complete = false) {
    setBusy(true);
    setError(undefined);
    const response = await fetch('/api/onboarding', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentStep: next, selectedAgent: next === 'complete' || next === 'agent' ? agent : undefined, complete }),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) setError(result.error ?? 'Setup could not be saved.');
    else if (complete) { router.push('/dashboard'); router.refresh(); }
    else setStep(next);
    setBusy(false);
  }

  const activeIndex = Math.max(0, STEPS.findIndex((item) => item.id === step));
  return (
    <div className="onboarding-shell">
      <ol className="onboarding-progress" aria-label="Setup progress">
        {STEPS.map((item, index) => <li key={item.id} data-active={item.id === step} data-complete={index < activeIndex}><span>{index + 1}</span>{item.label}</li>)}
      </ol>
      {error ? <div className="error-callout" role="alert">{error}</div> : null}
      {oauthError ? <div className="error-callout" role="alert">{oauthError}</div> : null}

      {step === 'welcome' ? <section className="onboarding-hero">
        <span className="plan-kicker">About four minutes</span>
        <h1>Bring your ad accounts into one safe agent workspace.</h1>
        <p>Connect providers, choose exactly which accounts an agent may access, then add Adport to ChatGPT, Codex, Claude, Cursor, or VS Code.</p>
        <div className="onboarding-points"><span>OAuth credentials stay encrypted</span><span>Every write requires an exact preview</span><span>New campaigns start paused</span></div>
        <button className="button" disabled={busy} onClick={() => void advance('connect')}>Start setup</button>
      </section> : null}

      {step === 'connect' ? <section className="onboarding-stage">
        <div className="onboarding-title"><span className="plan-kicker">Step 2</span><h1>Connect an ad platform</h1><p>Start with one provider. You can add the rest later from Connections.</p></div>
        <ProviderConnections organizationId={organizationId} canManage={canManage} connections={connections} oauthProviders={providers} returnTo="/onboarding" />
        <div className="onboarding-actions"><button className="button" disabled={busy} onClick={() => void advance('accounts')}>{connections.length ? 'Choose accounts' : 'Continue without a provider'}</button><button className="button secondary" onClick={() => void advance('welcome')}>Back</button></div>
      </section> : null}

      {step === 'accounts' ? <section className="onboarding-stage">
        <div className="onboarding-title"><span className="plan-kicker">Step 3</span><h1>Choose the accounts your agents can use</h1><p>Nothing is enabled automatically. Read access and guarded writes only apply to the accounts you activate here.</p></div>
        {accounts.length ? <AccountAccessManager organizationId={organizationId} accounts={accounts} canManage={canManage} maxActiveAccounts={maxActiveAccounts} /> : <div className="card"><div className="empty"><h2>No accounts discovered yet</h2><p>Connect a provider first, or continue and add one from the dashboard later.</p></div></div>}
        <div className="onboarding-actions"><button className="button" disabled={busy} onClick={() => void advance('agent')}>Connect an agent</button><button className="button secondary" onClick={() => void advance('connect')}>Back</button></div>
      </section> : null}

      {step === 'agent' ? <section className="onboarding-stage">
        <div className="onboarding-title"><span className="plan-kicker">Step 4</span><h1>Add Adport to your agent</h1><p>Choose your client, copy its setup, and finish the secure workspace authorization in your browser.</p></div>
        <AgentSetupGuide baseUrl={baseUrl} initialSelectedId={agent} onSelectionChange={setAgent} />
        <div className="onboarding-actions"><button className="button" disabled={busy} onClick={() => void advance('complete', true)}>{busy ? 'Finishing…' : 'Finish setup'}</button><button className="button secondary" onClick={() => void advance('accounts')}>Back</button></div>
      </section> : null}
    </div>
  );
}
