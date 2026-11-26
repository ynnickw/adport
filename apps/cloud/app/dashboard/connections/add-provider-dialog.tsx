'use client';

import { useState } from 'react';
import { Button } from '@/components/controls';
import { SearchField } from '@/components/list-controls';
import { Empty } from '@/components/ui';
import { Dialog } from '@/components/dialog';
import { ProviderConnections, type ConnectionView, type OAuthProviderView } from './provider-connections';
import { providerLabel } from '@/lib/cloud/providers';

export function AddProviderDialog({ projectId, projectName, providers, connections, category, className = 'button' }: {
  projectId: string; projectName: string; providers: OAuthProviderView[]; connections: ConnectionView[];
  category: 'advertising' | 'analytics'; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const analytics = category === 'analytics';
  const label = analytics ? 'Add source' : 'Add accounts';
  const choices = providers.filter(provider => provider.available || connections.some(connection => connection.provider === provider.id && connection.accountSelectionId && !connection.accountSelectionUnavailable));
  const matching = choices.filter(provider => providerLabel(provider.id).toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <Button type="button" className={className} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setQuery(''); setOpen(true); }}>{label}</Button>
    {open ? <Dialog title={label} className="provider-chooser-dialog" onClose={() => setOpen(false)}>
      <p className="plan-kicker">Project · {projectName}</p>
      {choices.length > 5 ? <SearchField data-autofocus="fine-pointer" value={query} onChange={event => setQuery(event.target.value)} aria-label="Find a platform" placeholder="Find a platform…" /> : null}
      {matching.length ? <ProviderConnections organizationId={projectId} projectName={projectName} canManage
        connections={connections} oauthProviders={matching} returnTo={analytics ? '/dashboard/analytics' : undefined} variant="chooser" />
        : <Empty heading="h3" className="compact-empty" title={choices.length ? 'No matching platforms' : 'No platforms available'} copy={choices.length ? undefined : 'Try again later.'}>
          {choices.length ? <Button className="button secondary small" type="button" onClick={() => setQuery('')}>Clear search</Button> : null}
        </Empty>}
    </Dialog> : null}
  </>;
}
