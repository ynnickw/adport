import type { ComponentProps, ReactNode } from 'react';
import Link from 'next/link';
import { Button, Input } from './controls';

export function SearchField({ className = '', ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <span className={`search-field ${className}`}>
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
    <Input {...props} type="search" />
  </span>;
}

export function ListToolbar({ children, filters, className = '', divided = false }: {
  children: ReactNode; filters?: ReactNode; className?: string; divided?: boolean;
}) {
  return <div className={`list-toolbar ${divided ? 'list-toolbar-divided' : ''} ${className}`}>
    <div className="list-toolbar-fields">{children}</div>{filters}
  </div>;
}

type Filter<Value extends string> = { value: Value; label: string; count?: number };

export function FilterButtons<const Value extends string>({ label, options, value, onChange, className = '' }: {
  label: string; options: readonly Filter<Value>[]; value: Value; onChange(value: NoInfer<Value>): void; className?: string;
}) {
  return <div className={`filter-tabs ${className}`} role="group" aria-label={label}>
    {options.map(option => <Button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
      {option.label}{option.count !== undefined ? <> <span>{option.count}</span></> : null}
    </Button>)}
  </div>;
}

export function FilterLinks<Value extends string>({ label, options, value, className = '' }: {
  label: string; options: readonly (Filter<Value> & { href: string })[]; value: Value; className?: string;
}) {
  return <nav className={`filter-tabs ${className}`} aria-label={label}>
    {options.map(option => <Link key={option.value} href={option.href} prefetch={false} aria-current={option.value === value ? 'page' : undefined}>
      {option.label}{option.count !== undefined ? <> <span>{option.count}</span></> : null}
    </Link>)}
  </nav>;
}
