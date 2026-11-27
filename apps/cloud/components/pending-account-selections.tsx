import { DashboardLink as Link } from './dashboard-navigation';
import { Provider } from './ui';
import { providerConnectionsPath, providerResourceName, usesAdAccountSlot } from '@/lib/cloud/providers';
import { pendingSelectionPath } from '@/lib/account-selection-path';

export function PendingAccountSelections({ connections, canManage, setupReturnTo, setupResume = false, noun = 'accounts' }: { connections: Array<{ provider: string; status: string; accountSelectionId?: string | null; accountSelectionUnavailable?: boolean }>; canManage: boolean; setupReturnTo?: string; setupResume?: boolean; noun?: 'accounts' | 'sources' }) {
  const pending = connections.filter(connection => connection.status === 'connected' && connection.accountSelectionId);
  if (!pending.length) return null;
  const label = pending.every(connection => !usesAdAccountSlot(connection.provider)) ? 'sources'
    : pending.some(connection => !usesAdAccountSlot(connection.provider)) ? 'accounts and sources' : noun;
  return <section className="card pending-account-selections" aria-label="Unfinished account selection">
    <div className="card-head"><h2>Finish adding {label}</h2><span className="status warn">Action needed</span></div>
    <div className="row-list">{pending.map(connection => <div className="row-item" key={connection.provider}><div><Provider name={connection.provider} /><div className="cell-sub">{connection.accountSelectionUnavailable ? 'This selection expired or was started by another admin.' : 'Selection not saved.'}</div></div>{canManage ? <Link className="button secondary small" href={connection.accountSelectionUnavailable ? setupReturnTo ? '/onboarding?step=connect&return_to=' + encodeURIComponent(setupReturnTo) + (setupResume ? '&resume=1' : '') : providerConnectionsPath(connection.provider) : pendingSelectionPath(connection.accountSelectionId!, connection.provider, setupReturnTo)}>{connection.accountSelectionUnavailable ? 'Restart selection' : `Choose ${providerResourceName(connection.provider)}`}</Link> : <span className="inline-note">An owner or admin must finish selection.</span>}</div>)}</div>
  </section>;
}
