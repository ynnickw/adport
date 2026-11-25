import type { ComponentProps } from 'react';

export function Button({ className = '', type, children, pending = false, pendingLabel, disabled, ...props }: ComponentProps<'button'> & { pending?: boolean; pendingLabel?: string }) {
  return <button {...props} type={type} className={`control-button ${className}`} disabled={disabled || pending}
    aria-busy={pending || props['aria-busy']} data-pending={pending ? '' : undefined}>
    {pendingLabel ? <span className="button-face">
      <span className="button-face-idle" aria-hidden={pending || undefined}>{children}</span>
      <span className="button-face-pending" aria-hidden={!pending || undefined}><Spinner />{pendingLabel}</span>
    </span> : children}
  </button>;
}

export function Spinner() { return <span className="action-spinner" aria-hidden="true" />; }

export function Chevron({ direction = 'down' }: { direction?: 'down' | 'right' | 'left' }) {
  return <svg className="control-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d={direction === 'left' ? 'm10 4-4 4 4 4' : direction === 'right' ? 'm6 4 4 4-4 4' : 'm4 6 4 4 4-4'} /></svg>;
}

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`control-input ${className}`} />;
}

export function Checkbox({ className = '', ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <input {...props} type="checkbox" className={`control-checkbox ${className}`} />;
}

export function Switch({ checked, className = '', ...props }: Omit<ComponentProps<'button'>, 'role' | 'aria-checked'> & { checked: boolean }) {
  return <Button {...props} type="button" role="switch" aria-checked={checked} className={'control-switch ' + className}><span className="switch-track"><span className="switch-thumb" /></span></Button>;
}

export function Textarea({ className = '', ...props }: ComponentProps<'textarea'>) {
  return <textarea {...props} className={`control-textarea ${className}`} />;
}

export function Disclosure({ label, children, className = '', ...props }: ComponentProps<'details'> & { label: React.ReactNode }) {
  return <details {...props} className={`disclosure ${className}`}><summary><span>{label}</span><Chevron direction="right" /></summary><div className="disclosure-content">{children}</div></details>;
}
