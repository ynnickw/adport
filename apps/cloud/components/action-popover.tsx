'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAnchoredLayer } from './anchored-layer';
import { Button, Chevron } from './controls';

/** A non-modal action panel. Tab navigates ordinary buttons, links or form controls. */
export function ActionPopover({ label, triggerLabel, panelLabel = label, children, onOpen, triggerClassName, panelClassName, width = 232, iconOnly = false }: {
  label: string;
  panelLabel?: string;
  triggerLabel: ReactNode;
  children: (close: () => void) => ReactNode;
  onOpen?(): void;
  triggerClassName?: string;
  panelClassName?: string;
  width?: number;
  iconOnly?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const surface = panel.current;
    if (!surface || typeof surface.showPopover !== 'function') return;
    if (open) surface.showPopover();
    else surface.hidePopover();
  }, [open]);
  const position = useAnchoredLayer(open, trigger, panel, { align: 'end', minWidth: width, maxWidth: width, heightLimit: 416 });
  const positioned = position.visibility !== 'hidden';

  function close() {
    const wasOpen = !panel.current?.hidden;
    setOpen(false);
    if (wasOpen) trigger.current?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (!open || !positioned) return;
    const target = panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current;
    target?.focus({ preventScroll: true });
  }, [open, positioned]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  return <>
    <Button ref={trigger} type="button" className={triggerClassName ?? 'button secondary small dropdown-trigger'}
      aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
      onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}
      onClick={() => { if (!open) onOpen?.(); setOpen(!open); }}>
      {triggerLabel}{iconOnly ? null : <Chevron />}
    </Button>
    <div ref={panel} id={id} popover="manual" hidden={!open} className={`floating-surface ${panelClassName ?? ''}`} style={position}
      role="dialog" aria-label={panelLabel} tabIndex={-1}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}
      onBlur={event => {
        // Do not steal focus on Tab or an outside click.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) setOpen(false);
      }}>
      {children(close)}
    </div>
  </>;
}
