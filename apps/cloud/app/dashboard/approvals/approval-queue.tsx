import { Empty, PageHeader, Provider, formatDate, formatMoney } from '@/components/ui';
import Link from 'next/link';
import { providerLabel } from '@/components/logos';
import type { PendingOperationRow } from '@/lib/cloud/repository';
import { Disclosure } from '@/components/controls';

function expiryLabel(expiresAt: Date): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }).format(expiresAt);
}

// Provider summaries count money in micros; show amounts the way people read them.
function readableSummary(summary: string, currency?: string): string {
  const money = (micros: string) => currency ? formatMoney(Number(micros) / 1e6, currency) : `${new Intl.NumberFormat('en', { maximumFractionDigits: 6 }).format(Number(micros) / 1e6)} (currency unavailable)`;
  // Only numbers the summary labels as micros; IDs and counts stay untouched.
  return summary
    .replace(/(\d+) → (\d+) micros\b/g, (_, from: string, to: string) => `${money(from)} → ${money(to)}`)
    .replace(/(\d+) micros\b/g, (_, value: string) => money(value));
}

// One pending operation, drawn as the same preview ticket the adport.dev write-gate demo uses.
function Ticket({ operation }: { operation: PendingOperationRow }) {
  const preview = operation.preview;
  const delta = preview?.budgetDeltas?.[0];
  const currency = delta?.currency;
  const budgetAmount = (micros: number) => currency ? formatMoney(micros / 1e6, currency) : new Intl.NumberFormat('en', { maximumFractionDigits: 6 }).format(micros / 1e6);
  const change = delta?.fromMicros ? ((delta.toMicros - delta.fromMicros) / delta.fromMicros) * 100 : null;
  return (
    <article className="ticket" aria-labelledby={`ticket-${operation.id}`}>
      <header className="ticket-head">
        <span className="ticket-status"><i aria-hidden="true" />Preview, not applied</span>
        <Provider name={operation.provider} />
      </header>
      <h2 className="ticket-summary" id={`ticket-${operation.id}`} title={preview?.summary}>{preview ? readableSummary(preview.summary, currency) : operation.operation.tool}</h2>
      <p className="ticket-account">Account <span>{operation.operation.accountId}</span></p>
      {delta ? (
        <p className="ticket-diff">
          {delta.fromMicros !== undefined ? <><s>{budgetAmount(delta.fromMicros)}</s><span className="diff-arrow" aria-hidden="true" /><span className="sr-only">to</span></> : null}
          <strong>{budgetAmount(delta.toMicros)}</strong>
          {!currency ? <span className="status warn">Currency unavailable</span> : null}
          {change !== null ? <span className="diff-delta">{change >= 0 ? '+' : ''}{change.toFixed(1)}%</span> : null}
          <span className="diff-target">{delta.target}</span>
        </p>
      ) : null}
      <ul className="ticket-checks">
        {preview?.changes.map((line) => <li key={line}>{line}</li>)}
        {preview?.serverValidated ? <li>{providerLabel(operation.provider)} validated the request in dry run</li> : null}
      </ul>
      {preview?.coercions.length ? <p className="ticket-coercion">Changed by policy: {preview.coercions.join('; ')}</p> : null}
      <footer className="ticket-stub">
        <div className="ticket-ttl"><span>Expires</span><time dateTime={operation.expiresAt.toISOString()} title={formatDate(operation.expiresAt)}>{expiryLabel(operation.expiresAt)}</time></div>
        <Disclosure className="ticket-details" label="Technical details"><div className="ticket-token"><span>Operation ID</span><code>{operation.id}</code></div>
          <p className="ticket-note"><code>{operation.operation.tool}</code> must use the same arguments and account {operation.operation.accountId}.</p>
        </Disclosure>
      </footer>
    </article>
  );
}

export function ApprovalQueue({ pending }: { pending: PendingOperationRow[] }) {
  const ordered = pending.filter(operation => operation.expiresAt.getTime() > Date.now()).sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  return (
    <main className="page">
      <PageHeader title="Approvals" action={<Link href="/dashboard/audit" className="button secondary">View history</Link>} />
      {ordered.length === 0 ? (
        <section className="card">
          <Empty title="Nothing waiting for approval" copy="Changes your assistant previews will appear here." href="/dashboard/policies" action="View safeguards" />
        </section>
      ) : (
        <section aria-label={`${ordered.length} pending operations`}>
          <div className="approval-intro"><div><strong>Approve in your assistant</strong><p>Return to the conversation that created the preview to approve or decline. Nothing here has been applied.</p></div>
            <span className="card-note">{pending.length === 50 ? `${ordered.length} shown · latest 50 loaded` : `${ordered.length} awaiting review`}</span></div>
          <div className="ticket-grid">
            {ordered.map(operation => <Ticket key={operation.id} operation={operation} />)}
          </div>
        </section>
      )}
    </main>
  );
}
