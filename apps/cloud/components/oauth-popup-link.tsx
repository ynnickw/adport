'use client';

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { openProviderPopup } from '@/lib/oauth-popup';
import { Dialog } from '@/components/dialog';
import { providerResourceName } from '@/lib/cloud/providers';
import { ConnectionSteps } from './connection-steps';

export function OAuthPopupLink({ href, label, platform, projectName, className, resourceProvider, children }: {
  href: string; label: string; platform: string; projectName: string; className: string; resourceProvider?: string; children: ReactNode;
}) {
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const [stage, setStage] = useState<'authorize' | 'same-tab' | 'opening' | 'returning' | 'timeout'>();
  const resources = providerResourceName(resourceProvider ?? '');
  useEffect(() => () => cleanup.current?.(), []);

  function close() {
    cleanup.current?.();
    cleanup.current = undefined;
    setStage(undefined);
  }

  function open(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    cleanup.current?.();
    // Fetch fresh picker state, including after a same-route error or a project change in another tab.
    cleanup.current = openProviderPopup(href, (path) => {
      const target = new URL(path, window.location.origin);
      // Commit the handoff before the document starts its next navigation.
      flushSync(() => setStage(target.searchParams.has('selection_id') ? 'opening' : 'returning'));
      window.location.assign(path);
    }, () => setStage('timeout'));
    event.preventDefault();
    setStage(cleanup.current ? 'authorize' : 'same-tab');
  }

  return <>
    <a href={href} aria-label={label} className={className} onClick={open}>{children}</a>
    {stage ? <Dialog title={`${platform} setup`} className="provider-handoff" onClose={close} portal>
      <p className="plan-kicker">Project · {projectName}</p>
      <ConnectionSteps active={stage === 'opening' ? 'choose' : stage === 'returning' ? undefined : 'sign-in'} resources={resources} />
      <div className="provider-handoff-status" role="status">
        {stage === 'opening' || stage === 'returning' ? <span className="provider-handoff-spinner" aria-hidden="true" /> : null}
        <div>
          <strong>{stage === 'opening' ? `Opening ${providerResourceName(resourceProvider ?? '', 1)} selection…` : stage === 'returning' ? 'Returning to Adport…' : stage === 'timeout' ? 'Sign-in window timed out' : stage === 'authorize' ? `Finish sign-in in the ${platform} window` : `Continue to ${platform} to sign in`}</strong>
          <p>{stage === 'authorize' || stage === 'same-tab' ? `After sign-in, you’ll choose which ${resources} to add.` : stage === 'timeout' ? 'Start again to get a fresh sign-in link.' : null}</p>
        </div>
      </div>
      {stage === 'authorize' || stage === 'same-tab' || stage === 'timeout' ? <a href={href} className={stage === 'authorize' ? 'button secondary small' : 'button small'} onClick={() => cleanup.current?.()}>Continue in this tab</a> : null}
    </Dialog> : null}
  </>;
}
