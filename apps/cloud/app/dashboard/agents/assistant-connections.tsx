'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolSelection } from '@adport/core/tool-catalog';
import { Button, Disclosure } from '@/components/controls';
import { formatDate, formatRelative } from '@/components/ui';
import { ToolCatalogEditor } from '@/components/tool-catalog-editor';
import { LEGACY_TOOL_SELECTION } from '@/lib/mcp-tool-selection';
import { AgentIdentityLogo } from './agent-setup-guide';

export interface OAuthGrantSummary {
  toolSelection?: ToolSelection;
  organizationGroupId?: string | null;
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

export function AssistantConnections({ organizationId, currentUserId, initialGrants, initialCheckedAt }: {
  organizationId: string; currentUserId: string; initialGrants: OAuthGrantSummary[]; initialCheckedAt: number;
}) {
  const [snapshot, setSnapshot] = useState<{ grants: OAuthGrantSummary[]; checkedAt: number; source: number }>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  const { grants, checkedAt } = snapshot?.source === initialCheckedAt ? snapshot : { grants: initialGrants, checkedAt: initialCheckedAt };

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setChecking(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/api-keys?organization_id=${organizationId}&view=connections`, { cache: 'no-store', signal: controller.signal });
      const data = await response.json() as { oauthGrants?: OAuthGrantSummary[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Unable to load assistant connections.');
      if (!controller.signal.aborted) setSnapshot({ grants: data.oauthGrants ?? [], checkedAt: Date.now(), source: initialCheckedAt });
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load assistant connections.');
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }, [organizationId, initialCheckedAt]);

  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener('focus', refresh);
    return () => { request.current?.abort(); window.removeEventListener('focus', refresh); };
  }, [load]);

  const active = grants.filter(grant => grant.status === 'active').sort((a, b) =>
    Number(Boolean(b.lastUsedAt)) - Number(Boolean(a.lastUsedAt)) || Date.parse(b.lastUsedAt ?? b.createdAt) - Date.parse(a.lastUsedAt ?? a.createdAt));
  const previous = grants.filter(grant => grant.status !== 'active').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  function rows(items: OAuthGrantSummary[]) {
    return items.map(grant => (
      <div className="row-item assistant-connection" key={`${grant.clientId}:${grant.userId}:${grant.resource}:${grant.organizationGroupId ?? 'project'}:${grant.createdAt}`}>
        <AgentIdentityLogo name={grant.clientName} clientUri={grant.clientUri} />
        <div className="assistant-connection-details">
          <div className="agent-identity"><strong>{grant.clientName}</strong><span className={`status ${grant.status !== 'active' || !grant.lastUsedAt ? 'neutral' : ''}`}>{grant.status === 'active' ? grant.lastUsedAt ? 'In use' : 'Waiting for first read' : grant.status === 'revoked' ? 'Disconnected' : 'Sign in again'}</span></div>
          <div className="assistant-grant-meta">
            <span>{grant.organizationGroupId ? 'All accessible projects' : 'This project'}</span>
            <span>{grant.scopes.includes('tools:write') && grant.toolSelection?.profile !== 'reporting' && grant.toolSelection?.providers?.length !== 0 ? 'Read and propose changes' : 'Read only'}</span>
            <span title={`Authorized ${formatDate(grant.createdAt)} · Expires ${formatDate(grant.expiresAt)}`}>{grant.lastUsedAt ? `Last used ${formatRelative(grant.lastUsedAt, checkedAt)}` : 'Never used'}</span>
          </div>
          {grant.status === 'active' && grant.userId === currentUserId ? <ToolCatalogEditor organizationId={organizationId}
            connection={{ type: 'oauth', client_id: grant.clientId, user_id: grant.userId, resource: grant.resource, organization_group_id: grant.organizationGroupId ?? null }}
            initialSelection={grant.toolSelection ?? LEGACY_TOOL_SELECTION} onSaved={() => void load()} /> : null}
        </div>
      </div>
    ));
  }

  return <section className="card assistant-connections" id="connected-assistants" aria-label="Connected assistants">
    <div className="card-head"><h2>Connected assistants <span className="card-note">{active.length}</span></h2><Button type="button" className="button secondary small" pending={checking} pendingLabel="Checking…" onClick={() => void load()}>Refresh status</Button></div>
    {error ? <div className="card-body"><div className="error-callout" role="alert">{error}</div></div> : null}
    <div className="row-list">
      {!active.length ? <div className="assistant-connections-empty"><strong>{previous.length ? 'No active connections' : 'No assistant connected yet'}</strong><p>Use Connect assistant to authorize this project.</p></div> : rows(active)}
    </div>
    {previous.length ? <Disclosure className="assistant-connection-group" label={`Previous connections (${previous.length})`}>
      <div className="row-list">{rows(previous)}</div>
    </Disclosure> : null}
  </section>;
}
