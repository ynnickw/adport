'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ProviderLogo } from './logos';
import { AgentLogo } from '@/app/dashboard/agents/agent-setup-guide';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';
import { providerLabel } from '@/lib/cloud/providers';

export function PricingProviderStack({ planName }: { planName?: string }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties>();
  const close = () => { pinned.current = false; setOpen(false); };
  useLayoutEffect(() => {
    if (!open || !planName) return;
    function place() {
      if (!root.current || !tooltip.current) return;
      const anchor = root.current.getBoundingClientRect();
      const bounds = tooltip.current.getBoundingClientRect();
      const margin = 16; const gap = 12;
      const topEdge = (root.current.closest('dialog')?.querySelector('.dialog-heading')?.getBoundingClientRect().bottom ?? 0) + margin;
      const above = anchor.top - topEdge - gap;
      const below = window.innerHeight - anchor.bottom - margin - gap;
      const placeBelow = above < bounds.height && below > above;
      const maxHeight = Math.max(80, placeBelow ? below : above);
      setPosition({ left: Math.max(margin, Math.min(anchor.left + (anchor.width - bounds.width) / 2, window.innerWidth - bounds.width - margin)), top: Math.max(topEdge, placeBelow ? anchor.bottom + gap : anchor.top - gap - Math.min(bounds.height, maxHeight)), maxHeight });
    }
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [open, planName]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  return <div className={`provider-stack${planName ? ' provider-stack-card' : ''}`} data-provider-tooltip ref={root}
    onPointerEnter={event => { clearTimeout(closeTimer.current); if (event.pointerType !== 'touch') setOpen(true); }}
    onPointerLeave={() => { if (!pinned.current) closeTimer.current = setTimeout(() => { if (!root.current?.contains(document.activeElement)) close(); }, 120); }}
    onFocus={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}
    onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <div className="provider-stack-marks" aria-hidden="true">{OAUTH_PROVIDERS.slice(0, 4).map(provider => <span className="pricing-provider-logo" key={provider}><ProviderLogo name={provider} /></span>)}</div>
    <button className="provider-more" type="button" aria-label={`Show all ${OAUTH_PROVIDERS.length} ad platforms${planName ? ` included with ${planName}` : ''}`} aria-expanded={open} aria-controls={id} aria-describedby={open ? id : undefined} onClick={() => { pinned.current = !pinned.current; setOpen(pinned.current); }}>+{OAUTH_PROVIDERS.length - 4}</button>
    <div className="provider-tooltip" id={id} role="tooltip" hidden={!open} ref={tooltip} style={planName ? position : undefined}><p>{OAUTH_PROVIDERS.length} ad platform integrations</p><ul>{OAUTH_PROVIDERS.map(provider => <li key={provider}><span className="pricing-provider-logo" aria-hidden="true"><ProviderLogo name={provider} /></span><span>{providerLabel(provider)}</span></li>)}</ul><span className="provider-tooltip-note">Provider access depends on your account and API permissions.</span></div>
  </div>;
}

export function PricingAgentMarks({ mcp = false }: { mcp?: boolean }) {
  return <span className="pricing-card-agent-logos" aria-hidden="true">{mcp ? <span className="pricing-card-agent"><AgentLogo provider="mcp" /></span> : <><span className="pricing-card-agent"><AgentLogo provider="openai" /></span><span className="pricing-card-agent pricing-card-agent-claude"><AgentLogo provider="anthropic" /></span></>}</span>;
}

export function PricingConnectors() {
  return <><span className="pricing-connector pricing-connector-chatgpt"><AgentLogo provider="openai" /><span>ChatGPT <small>Plugin</small></span></span><span className="pricing-connector pricing-connector-claude"><AgentLogo provider="anthropic" /><span>Claude <small>Connector</small></span></span><span className="pricing-connector pricing-connector-mcp"><AgentLogo provider="mcp" /><span>Any MCP client <small>Other AI agents</small></span></span></>;
}

export function PricingEcosystem() {
  return <div className="pricing-ecosystem"><div className="pricing-platforms"><PricingProviderStack /><span>{OAUTH_PROVIDERS.length} ad platforms</span></div><div className="pricing-connectors" aria-label="AI integrations"><PricingConnectors /></div></div>;
}
