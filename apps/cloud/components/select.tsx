'use client';

import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './controls';

export interface SelectOption { value: string; label: string; group?: string; disabled?: boolean }
interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  id?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  'aria-label': string;
}

export function Select({ options, value, defaultValue, onValueChange, name, id, disabled, required, className = '', 'aria-label': label }: SelectProps) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const listId = `${generatedId}-options`;
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const initialValue = defaultValue ?? options.find(option => !option.disabled)?.value ?? '';
  const [localValue, setLocalValue] = useState(initialValue);
  const selectedValue = value ?? localValue;
  const selected = options.find(option => option.value === selectedValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<React.CSSProperties>();
  const typed = useRef({ text: '', at: 0 });
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
  const select = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setLocalValue(option.value);
    setOpen(false);
    if (option.value !== selectedValue) onValueChange?.(option.value);
  };
  const show = () => { setActive(Math.max(0, options.findIndex(option => option.value === selectedValue))); setOpen(true); };
  useEffect(() => { if (value === undefined) setLocalValue(initialValue); }, [initialValue, value]);
  useEffect(() => {
    const form = trigger.current?.closest('form');
    const reset = () => { setLocalValue(initialValue); setOpen(false); };
    form?.addEventListener('reset', reset);
    return () => form?.removeEventListener('reset', reset);
  }, [initialValue]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = below < 180 && rect.top > below;
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 220) - 8)),
        width: Math.min(Math.max(rect.width, 220), window.innerWidth - 16),
        maxHeight: Math.max(100, Math.min(300, above ? rect.top - 12 : below)),
        ...(above ? { bottom: window.innerHeight - rect.top + 5 } : { top: rect.bottom + 5 }) });
    };
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !list.current?.contains(event.target as Node)) setOpen(false);
    };
    place();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useEffect(() => { if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active, open]);
  return <span className={`select-control ${className}`}>
    {name ? <input type="hidden" name={name} value={selectedValue} disabled={disabled} /> : null}
    <Button ref={trigger} id={triggerId} type="button" role="combobox" className="select-trigger"
      disabled={disabled || enabled.length === 0} aria-label={`${label}: ${selected?.label ?? 'Choose'}`} aria-required={required}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
      aria-activedescendant={open ? `${listId}-${active}` : undefined}
      onClick={() => open ? setOpen(false) : show()}
      onBlur={() => setOpen(false)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) { show(); return; }
          const current = enabled.indexOf(active);
          setActive(enabled[(current + (event.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length] ?? 0);
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault(); setOpen(true); setActive((event.key === 'Home' ? enabled[0] : enabled.at(-1)) ?? 0);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); if (open) select(active); else show();
        } else if (event.key === 'Escape' || event.key === 'Tab') {
          if (open && event.key === 'Escape') event.preventDefault(); setOpen(false);
        } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          typed.current = { text: (Date.now() - typed.current.at < 700 ? typed.current.text : '') + event.key.toLowerCase(), at: Date.now() };
          const match = options.findIndex(option => !option.disabled && option.label.toLowerCase().startsWith(typed.current.text));
          if (match >= 0) { if (open) setActive(match); else select(match); }
        }
      }}>
      <span>{selected?.label ?? 'Choose an option'}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </Button>
    {open && position ? createPortal(<div ref={list} className="select-options" role="listbox" id={listId} aria-label={label} style={position}>
      {options.map((option, index) => <div key={option.value}>
        {option.group && option.group !== options[index - 1]?.group ? <div className="select-group">{option.group}</div> : null}
        <div role="option" id={`${listId}-${index}`} aria-selected={option.value === selectedValue} aria-disabled={option.disabled}
          data-active={active === index} onMouseDown={event => event.preventDefault()} onMouseMove={() => !option.disabled && setActive(index)} onClick={() => select(index)}>
          <span>{option.label}</span>{option.value === selectedValue ? <span aria-hidden="true">✓</span> : null}
        </div>
      </div>)}
    </div>, trigger.current?.closest('dialog') ?? document.body) : null}
  </span>;
}
