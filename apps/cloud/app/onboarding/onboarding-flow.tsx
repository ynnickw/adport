'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/controls';
import { Notice } from '@/components/feedback';
import { SuccessToast } from '@/components/toast';
import { ListToolbar, SearchField } from '@/components/list-controls';
import { Empty } from '@/components/ui';
import { BrandLockup } from '@/components/logos';
import { SupportLauncher } from '@/components/support-widget';
import { PendingAccountSelections } from '@/components/pending-account-selections';
import { isCloudProvider, type CloudProvider } from '@/lib/cloud/types';
import { providerLabel, providerResourceName } from '@/lib/cloud/providers';
import { ProviderAccountPicker, type ProviderAccountSelection } from '../account-selection/provider-account-picker';
import { AccountAccessManager, type AccountAccessItem } from '../dashboard/accounts/account-access-manager';
import { AssistantConnect } from '@/components/assistant-connect';
import type { AssistantConnectionStatus } from '@/lib/cloud/assistant-connection';
import type { AssistantListings } from '@/lib/assistant-listings';
import { ProviderConnections, type ConnectionView, type OAuthProviderView } from '../dashboard/connections/provider-connections';
import { SetupProgress, type SetupStep } from './setup-progress';
import { DialogTrigger } from '@/components/dialog';
import { WorkspaceNamesForm } from './workspace-names-form';

type Step = 'welcome' | SetupStep | 'complete';
type PersistedStep = Exclude<Step, 'workspace'>;

export function OnboardingFlow({ organizationId, projectName, setupKind, projectSwitcher, resuming = false, canManage, initialStep, initialAgent, baseUrl, listings, connectedProvider, pendingSelection, accountsSaved = false, accountsEnabled = false, oauthError, providers, connections, accounts, maxActiveAccounts, organizationActiveCount, returnTo, workspace }: {
  organizationId: string;
  projectName: string;
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
  workspace?: { organizationName: string; projectName: string };
}) {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const shouldFocus = useRef(false);
  const flight = useRef(false);
  const [step, setStep] = useState<SetupStep>(pendingSelection ? 'accounts' : accountsEnabled ? 'agent' : connectedProvider ? 'accounts' : initialStep === 'welcome' ? 'connect' : initialStep === 'complete' ? 'agent' : initialStep);
  const [agent, setAgent] = useState(initialAgent ?? 'chatgpt');
  const [assistantStatus, setAssistantStatus] = useState<AssistantConnectionStatus>();
  const setupReady = Boolean(assistantStatus?.verified && assistantStatus.hasAccounts);
  const [action, setAction] = useState<'next' | 'back' | 'exit'>();
  const busy = Boolean(action);
  const [error, setError] = useState<string>();
  const [providerFilter, setProviderFilter] = useState<CloudProvider | undefined>(connectedProvider && isCloudProvider(connectedProvider) ? connectedProvider : undefined);
  const [query, setQuery] = useState('');
  const onboardingPath = '/onboarding?' + new URLSearchParams({ return_to: returnTo, ...(resuming ? { resume: '1' } : {}) });
  const byProvider = new Map(connections.map(connection => [connection.provider, connection]));
  const accountRows = accounts.map(account => {
    const connection = byProvider.get(account.provider);
    return { ...account, connectionStatus: connection?.status ?? 'revoked', accountSelectionId: connection?.accountSelectionId, accountSelectionUnavailable: connection?.accountSelectionUnavailable };
  });
  const connected = connections.some(connection => connection.status === 'connected');
  const hasEnabledAccounts = accountRows.some(account => account.enabled && account.connectionStatus === 'connected' && !account.accountSelectionId);
  const hasPendingSelection = connections.some(connection => connection.status === 'connected' && connection.accountSelectionId);
  const accountStepAvailable = Boolean(accounts.length || hasPendingSelection);
  const eligibleProviders = providers.filter(provider => provider.available || byProvider.has(provider.id));
  const matchingProviders = eligibleProviders.filter(provider => providerLabel(provider.id).toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    if (shouldFocus.current) { heading.current?.focus(); shouldFocus.current = false; }
  }, [step]);

  async function advance(next: PersistedStep, options: { complete?: boolean; skip?: boolean } = {}, intent: 'next' | 'back' | 'exit' = 'next') {
    if (flight.current) return;
    flight.current = true;
    setAction(intent); setError(undefined);
    let leaving = false;
    try {
      const response = await fetch('/api/onboarding', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentStep: next, selectedAgent: agent, setupKind, ...options }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) setError(result.error ?? 'Setup could not be saved. Please try again.');
      else if (options.complete || options.skip) { leaving = true; router.replace(returnTo); router.refresh(); }
      else if (next !== 'complete' && next !== 'welcome') {
        shouldFocus.current = true;
        if (step === 'agent') setAssistantStatus(undefined);
        if (next === 'connect') setQuery('');
        setStep(next);
        // The state is already saved. Update the resume URL without reloading
        // server data or carrying over one-time OAuth result parameters.
        window.history.replaceState(null, '', onboardingPath + '&step=' + next);
      }
    } catch { setError('Setup could not be saved. Check your connection and try again.'); }
    finally { if (!leaving) { flight.current = false; setAction(undefined); } }
  }

  const selectingAccounts = step === 'accounts' && Boolean(pendingSelection);
  const skip = () => void advance(step === 'workspace' ? 'welcome' : step, { skip: true }, 'exit');
  const title = step === 'workspace' ? 'Name your workspace' : step === 'connect' ? 'Connect a platform' : step === 'accounts' ? pendingSelection
    ? `Choose your ${providerLabel(pendingSelection.provider)} ${providerResourceName(pendingSelection.provider)}.` : 'Enable account access'
    : setupReady ? 'Your assistant is ready' : 'Connect your assistant';
  return <>
    <SuccessToast message={accountsSaved ? accountsEnabled ? 'Accounts enabled for assistants.' : 'Selection saved without enabling new accounts.' : undefined} />
    <header className="onboarding-head">
      <Link href={returnTo} aria-label="Adport dashboard" onClick={event => { event.preventDefault(); skip(); }}><BrandLockup /></Link>
      <div className="onboarding-project">{projectSwitcher ?? <><span className="setup-project-label">Project</span><span>{projectName}</span></>}</div>
      <div className="onboarding-head-actions"><SupportLauncher className="support-inline" /><Button type="button" className="button secondary small" disabled={busy} pending={action === 'exit'} pendingLabel="Leaving…" onClick={skip}>Set up later</Button></div>
    </header>
    <div className="setup-scroll"><div className="onboarding-shell setup-layout">
      <div className="setup-rail">
        <p className="setup-rail-label" aria-hidden="true">Project setup</p>
        <SetupProgress step={step} completed={{ workspace: workspace ? step !== 'workspace' : undefined, connect: connected, accounts: hasEnabledAccounts, agent: setupReady }} />
      </div>
      <div className="setup-flow">
        <div className="onboarding-title">
          <div className="setup-title-row">
            <h1 ref={heading} tabIndex={-1}>{title}</h1>
            {workspace && step !== 'workspace' ? <DialogTrigger label="Edit workspace names" title="Edit workspace names" className="button secondary small">
              <WorkspaceNamesForm {...workspace} projectId={organizationId} returnTo={returnTo} />
            </DialogTrigger> : null}
          </div>
          {step === 'workspace' ? <p>Your organization is the home for your projects. Give it and your first project names you’ll recognize.</p>
            : step === 'connect' ? <p>Start with one platform. Connecting won’t change your campaigns.</p>
            : step === 'accounts' && !selectingAccounts ? <p>Choose what your assistant can access in this project.</p> : null}
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {oauthError && step !== 'agent' ? <Notice tone="error">{oauthError}</Notice> : null}
        <div className="setup-flow-content">
          {step === 'workspace' && workspace ? <section className="card workspace-setup-card">
            <div className="card-body"><WorkspaceNamesForm {...workspace} projectId={organizationId} returnTo={returnTo} advance /></div>
          </section> : null}
          {step === 'connect' ? <>
            {eligibleProviders.length > 5 || !accountStepAvailable ? <ListToolbar
              filters={!accountStepAvailable ? <Button type="button" className="button secondary small" disabled={busy} pending={action === 'next'} pendingLabel="Continuing…" onClick={() => void advance('agent')}>Connect assistant first</Button> : null}>
              {eligibleProviders.length > 5 ? <SearchField aria-label="Find a platform" placeholder="Find a platform…" value={query} onChange={event => setQuery(event.target.value)} /> : null}
            </ListToolbar> : null}
            {query.trim() && !matchingProviders.length ? <section className="card"><Empty title="No matching platforms" copy="Try another platform name."><Button type="button" className="button secondary small" onClick={() => setQuery('')}>Clear search</Button></Empty></section> :
              <ProviderConnections variant="onboarding" organizationId={organizationId} projectName={projectName} canManage={canManage} connections={connections} oauthProviders={matchingProviders} returnTo={onboardingPath} />}
          </> : null}
          {step === 'accounts' ? pendingSelection ? <ProviderAccountPicker organizationId={organizationId} selectionId={pendingSelection.id} provider={pendingSelection.provider} accounts={pendingSelection.accounts} pages={pendingSelection.pages} initialSelectedIds={accounts.filter(account => account.provider === pendingSelection.provider).map(account => account.accountId)} initialEnabledIds={accounts.filter(account => account.provider === pendingSelection.provider && account.enabled).map(account => account.accountId)} maxActiveAccounts={maxActiveAccounts} organizationActiveCount={organizationActiveCount} backHref={onboardingPath + '&step=connect'} nextPath={onboardingPath} showProgress={false} /> : <>
            <PendingAccountSelections connections={connections} canManage={canManage} setupReturnTo={returnTo} setupResume={resuming} />
            {providerFilter ? <Button type="button" className="link-button" onClick={() => setProviderFilter(undefined)}>View all platforms’ accounts</Button> : null}
            {accounts.length || providerFilter ? <AccountAccessManager key={organizationId} organizationId={organizationId} accounts={accountRows} canManage={canManage} maxActiveAccounts={maxActiveAccounts} providerFilter={providerFilter} organizationActiveCount={organizationActiveCount} setupReturnTo={returnTo} /> : !hasPendingSelection ? <div className="card"><Empty title="No accounts added yet" copy="Go back to connect a platform, or connect your assistant now and add data later." /></div> : null}
          </> : null}
          {step === 'agent' ? <>
            <AssistantConnect baseUrl={baseUrl} projectName={projectName} initialAgent={agent} listings={listings} onSelectionChange={setAgent} onStatusChange={setAssistantStatus} canManageAccounts={canManage}
              accountAction={<Button type="button" className="link-button" disabled={busy} onClick={() => void advance(accountStepAvailable ? 'accounts' : 'connect', {}, 'back')}>Enable an account</Button>} />
          </> : null}
          </div>
          {step !== 'workspace' && !selectingAccounts && (step !== 'connect' || accountStepAvailable) ? <div className="setup-flow-actions">
            {step !== 'connect' ? <Button type="button" className="button secondary" disabled={busy} pending={action === 'back'} pendingLabel="Loading…" onClick={() => void advance(step === 'accounts' ? 'connect' : accountStepAvailable ? 'accounts' : 'connect', {}, 'back')}>Back</Button> : null}
            {step === 'agent' ? <><span className="setup-finish-hint">{!setupReady ? 'Finish after your assistant successfully reads an enabled account.' : null}</span><Button type="button" className="button" disabled={busy || !setupReady} pending={action === 'next'} pendingLabel="Finishing setup…" onClick={() => void advance('complete', { complete: true })}>Finish setup</Button></>
              : <Button type="button" className="button" disabled={busy} pending={action === 'next'} pendingLabel="Continuing…"
                onClick={() => void advance(step === 'connect' ? 'accounts' : 'agent')}>{step === 'connect' ? 'Continue to accounts' : hasEnabledAccounts ? 'Continue to assistant' : 'Continue without enabling'}</Button>}
          </div> : null}
      </div>
    </div></div>
  </>;
}
