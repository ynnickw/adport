'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredLayer } from './anchored-layer';
import { Button } from './controls';

export function InfoTooltip({ children, label = 'More information' }: { children: React.ReactNode; label?: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dismissTimer = useRef<number>(undefined);
  const [open, setOpen] = useState(false);
  const position = useAnchoredLayer(open, trigger, panel, { minWidth: 320, maxWidth: 320, heightLimit: 440 });

  function show() {
    window.clearTimeout(dismissTimer.current);
    setOpen(true);
  }

  function leave() {
    window.clearTimeout(dismissTimer.current);
    dismissTimer.current = window.setTimeout(() => {
      if (document.activeElement !== trigger.current) setOpen(false);
    }, 150);
  }

  useEffect(() => () => window.clearTimeout(dismissTimer.current), []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Keep the containing native dialog open when dismissing its tooltip.
      if (trigger.current?.closest('dialog[open]')) event.preventDefault();
      setOpen(false);
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    window.addEventListener('keydown', dismiss);
    window.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('keydown', dismiss);
      window.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  return <>
    <Button ref={trigger} type="button" className="info-trigger" aria-label={label} aria-describedby={open ? id : undefined}
      onPointerEnter={event => { if (event.pointerType === 'mouse') show(); }}
      onPointerLeave={event => { if (event.pointerType === 'mouse') leave(); }}
      onFocus={show} onBlur={() => setOpen(false)} onClick={show}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 9v5M10 6v.1" /></svg>
    </Button>
    {open ? createPortal(<div ref={panel} className="info-tooltip" role="tooltip" id={id} style={position}
      onPointerEnter={() => window.clearTimeout(dismissTimer.current)} onPointerLeave={leave}>{children}</div>,
    trigger.current?.closest('dialog') ?? document.body) : null}
  </>;
}
