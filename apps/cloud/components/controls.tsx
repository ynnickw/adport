import type { ComponentProps } from 'react';

export function Button({ className = '', type, ...props }: ComponentProps<'button'>) {
  return <button {...props} type={type} className={`control-button ${className}`} />;
}

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`control-input ${className}`} />;
}

export function Checkbox({ className = '', ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <input {...props} type="checkbox" className={`control-checkbox ${className}`} />;
}

export function Textarea({ className = '', ...props }: ComponentProps<'textarea'>) {
  return <textarea {...props} className={`control-textarea ${className}`} />;
}

export function Disclosure({ label, children, className = '', ...props }: ComponentProps<'details'> & { label: React.ReactNode }) {
  return <details {...props} className={`disclosure ${className}`}><summary><span>{label}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg></summary><div className="disclosure-content">{children}</div></details>;
}
