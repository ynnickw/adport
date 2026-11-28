'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import type { ToolProvider, ToolSelection } from '@adport/core/tool-catalog';
import { Button } from '@/components/controls';
import { formatDate, formatRelative } from '@/components/ui';
import { ToolCatalogEditor, toolAccessSummary } from '@/components/tool-catalog-editor';
import { LEGACY_TOOL_SELECTION, type ToolCatalogCountGroup } from '@/lib/mcp-tool-selection';
import { AgentIdentityLogo } from './agent-setup-guide';

export interface OAuthGrantSummary {
  toolSelection?: ToolSelection;
  organizationGroupId?: string | null;
  organizationGrantId?: string | null;
  catalogCounts?: readonly ToolCatalogCountGroup[];
  suggestedProviders?: readonly ToolProvider[];
  clientId: string;
  userId: string;
  clientName: string;
  clientUri: string | null;
  scopes: string[];
  resource: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  status: 'active' | 'rotated' | 'revoked' | 'expired';
}

const WAITING_STATUS_INTERVAL_MS = 10_000;

export function AssistantConnections({ organizationId, currentUserId, initialGrants, initialCheckedAt, requestedConnection }: {
  organizationId: string; currentUserId: string; initialGrants: OAuthGrantSummary[]; initialCheckedAt: number;
  requestedConnection?: { clientId: string; scope?: string };
}) {
  const [snapshot, setSnapshot] = useState<{ grants: OAuthGrantSummary[]; checkedAt: number; source: number }>();
  const [retrying, startRetry] = useTransition();
  const [error, setError] = useState<string>();
  const [showHistory, setShowHistory] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const { grants, checkedAt } = snapshot?.source === initialCheckedAt ? snapshot : { grants: initialGrants, checkedAt: initialCheckedAt };
  const waiting = grants.some(grant => grant.status === 'active' && !grant.lastUsedAt);

  const load = useCallback(async (replace = false) => {
    if (request.current && !replace) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch(`/api/api-keys?organization_id=${organizationId}&view=connections`, { cache: 'no-store', signal: controller.signal });
      const data = await response.json() as { oauthGrants?: OAuthGrantSummary[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Unable to load assistant connections.');
      if (!controller.signal.aborted) {
        setSnapshot({ grants: data.oauthGrants ?? [], checkedAt: Date.now(), source: initialCheckedAt });
        setError(undefined);
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load assistant connections.');
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  }, [organizationId, initialCheckedAt]);

  useEffect(() => {
    const refresh = () => { if (!document.hidden) void load(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      request.current?.abort();
      request.current = undefined;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  useEffect(() => {
    if (!waiting || error) return;
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, WAITING_STATUS_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [waiting, error, load]);

  const active = grants.filter(grant => grant.status === 'active').sort((a, b) =>
    Number(Boolean(b.lastUsedAt)) - Number(Boolean(a.lastUsedAt)) || Date.parse(b.lastUsedAt ?? b.createdAt) - Date.parse(a.lastUsedAt ?? a.createdAt));
  const previous = grants.filter(grant => grant.status !== 'active').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const requested = requestedConnection ? active.find(grant => grant.clientId === requestedConnection.clientId
    && grant.userId === currentUserId && (grant.organizationGrantId ?? grant.organizationGroupId ?? 'project') === (requestedConnection.scope ?? 'project')) : undefined;

  function rows(items: OAuthGrantSummary[]) {
    return items.map(grant => {
      const selection = grant.toolSelection ?? LEGACY_TOOL_SELECTION;
      const own = grant.userId === currentUserId;
      const activeGrant = grant.status === 'active';
      return <li className="assistant-list-row" key={`${grant.clientId}:${grant.userId}:${grant.resource}:${grant.organizationGrantId ?? grant.organizationGroupId ?? 'project'}:${grant.createdAt}`}>
        <div className="assistant-list-identity">
          <AgentIdentityLogo name={grant.clientName} clientUri={grant.clientUri} />
          <div>
            <strong>{grant.clientName}</strong>
            <small>{grant.organizationGrantId ? 'Multiple organizations' : grant.organizationGroupId ? 'All accessible projects' : 'This project'}{!own ? ' · Teammate’s connection' : ''}</small>
          </div>
        </div>
        <div className="assistant-list-status">
          <span className={`status ${activeGrant && grant.lastUsedAt ? '' : 'neutral'}`}>{activeGrant ? grant.lastUsedAt ? 'In use' : 'Waiting for first read' : grant.status === 'revoked' ? 'Disconnected' : 'Sign in again'}</span>
          {grant.lastUsedAt ? <small title={`Authorized ${formatDate(grant.createdAt)} · Expires ${formatDate(grant.expiresAt)}`}>Last used {formatRelative(grant.lastUsedAt, checkedAt)}</small> : null}
        </div>
        {activeGrant ? <div className="assistant-list-access">
          <span>{toolAccessSummary(selection)}</span>
          <small>{grant.scopes.includes('tools:write') && selection.profile !== 'reporting' && selection.providers?.length !== 0 ? 'Read and propose changes' : 'Read only'}</small>
        </div> : null}
        {activeGrant && own ? <div className="assistant-list-action"><ToolCatalogEditor organizationId={organizationId} name={grant.clientName} openOnLoad={grant === requested}
          catalogCounts={grant.catalogCounts} scopes={grant.scopes} suggestedProviders={grant.suggestedProviders}
          connection={{ type: 'oauth', client_id: grant.clientId, user_id: grant.userId, resource: grant.resource,
            organization_group_id: grant.organizationGroupId ?? null, organization_grant_id: grant.organizationGrantId ?? null }}
          initialSelection={selection} onSaved={() => void load(true)} /></div> : null}
      </li>;
    });
  }

  return <section className="card assistant-connections" id="connected-assistants" aria-label="Connected assistants">
    <div className="card-head"><h2>Connected assistants{active.length ? <span className="assistant-list-count">{active.length}</span> : null}</h2></div>
    {error ? <div className="card-body"><div className="error-callout row-actions">
      <span role="alert">{error}</span>
      <Button type="button" className="button secondary small" pending={retrying} pendingLabel="Checking…" onClick={() => startRetry(() => load(true))}>Retry</Button>
    </div></div> : null}
    {active.length ? <ul className="assistant-list">{rows(active)}</ul>
      : <div className="assistant-connections-empty"><strong>{previous.length ? 'No active connections' : 'No assistant connected yet'}</strong><p>Connect an assistant to use this project’s data in chat.</p></div>}
    {previous.length ? <div className="assistant-history">
      <Button type="button" className="link-button" aria-expanded={showHistory} aria-controls="assistant-connection-history" onClick={() => setShowHistory(current => !current)}>
        {showHistory ? 'Hide previous connections' : `Previous connections (${previous.length})`}
      </Button>
      <div id="assistant-connection-history" hidden={!showHistory}>{showHistory ? <ul className="assistant-list">{rows(previous)}</ul> : null}</div>
    </div> : null}
  </section>;
}
