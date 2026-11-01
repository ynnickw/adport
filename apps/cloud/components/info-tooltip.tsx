'use client';

import { useLayoutEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './controls';

export function InfoTooltip({ children, label = 'More information' }: { children: React.ReactNode; label?: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 332)), top: rect.bottom + 8 });
    };
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node)) setOpen(false); };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { capture: true, passive: true });
    window.addEventListener('keydown', dismiss);
    window.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('keydown', dismiss);
      window.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  return <>
    <Button ref={trigger} type="button" className="info-trigger" aria-label={label} aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 9v5M10 6v.1" /></svg>
    </Button>
    {open ? createPortal(<div className="info-tooltip" role="tooltip" id={id} style={position}>{children}</div>, trigger.current?.closest('dialog') ?? document.body) : null}
  </>;
}
