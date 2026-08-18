import Link from 'next/link';
import { BrandMark, ProviderLogo, providerLabel } from '@/components/logos';

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="subhead">{description}</p>
      </div>
      {action ? <div className="page-head-actions">{action}</div> : null}
    </div>
  );
}

export function Metric({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-foot">{foot}</div>
    </div>
  );
}

export function Empty({ title, copy, href, action }: { title: string; copy: string; href?: string; action?: string }) {
  return (
    <div className="empty">
      <BrandMark />
      <h2>{title}</h2>
      <p>{copy}</p>
      {href && action ? <Link className="button" href={href}>{action}</Link> : null}
    </div>
  );
}

export function Provider({ name }: { name: string }) {
  return (
    <span className="provider">
      <span className="provider-logo"><ProviderLogo name={name} /></span>
      {providerLabel(name)}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone = status === 'connected' ? '' : status === 'error' ? 'critical' : status === 'revoked' ? 'neutral' : 'warn';
  return <span className={`status ${tone}`}>{status}</span>;
}

export function AuthFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-bar">
          <div className="traffic" aria-hidden="true"><i /><i /><i /></div>
          <span>adport cloud — {label}</span>
        </div>
        <div className="auth-body">{children}</div>
      </section>
    </main>
  );
}

export function formatNumber(value = 0): string { return new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value); }
export function formatMoney(value = 0, currency = 'EUR'): string {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${formatNumber(value)} ${currency}`; }
}
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC';
}
