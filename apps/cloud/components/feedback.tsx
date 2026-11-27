import type { ReactNode } from 'react';
import { Spinner } from './controls';

export function Notice({ tone = 'info', children, className = '' }: { tone?: 'info' | 'error'; children: ReactNode; className?: string }) {
  return <div className={`${tone === 'error' ? 'error-callout' : 'callout'} ${className}`}
    role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function LoadingStatus({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`loading-status ${className}`} role="status"><Spinner />{children}</span>;
}

export function SkeletonRows({ count = 4, className = '', secondary = false }: { count?: number; className?: string; secondary?: boolean }) {
  return <div className={`skeleton-rows ${className}`} aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <div key={index}><span className="skeleton-line" />{secondary ? <span className="skeleton-line" /> : null}</div>)}
  </div>;
}
