import Link from 'next/link';
import { Provider } from './ui';
import { providerConnectionsPath } from '@/lib/cloud/providers';

export function PendingAccountSelections({ connections, canManage, setupReturnTo, setupResume = false, noun = 'accounts' }: { connections: Array<{ provider: string; status: string; accountSelectionId?: string | null; accountSelectionUnavailable?: boolean }>; canManage: boolean; setupReturnTo?: string; setupResume?: boolean; noun?: 'accounts' | 'sources' }) {
  const pending = connections.filter(connection => connection.status === 'connected' && connection.accountSelectionId);
  if (!pending.length) return null;
  return <section className="card pending-account-selections" aria-label="Unfinished account selection">
    <div className="card-head"><h2>Finish adding {noun}</h2><span className="status warn">Action needed</span></div>
    <div className="row-list">{pending.map(connection => <div className="row-item" key={connection.provider}><div><Provider name={connection.provider} /><div className="cell-sub">{connection.accountSelectionUnavailable ? 'This selection expired or was started by another admin.' : 'Platform connected. Selection not yet saved.'}</div></div>{canManage ? <Link className="button secondary small" href={connection.accountSelectionUnavailable ? setupReturnTo ? '/onboarding?step=connect&return_to=' + encodeURIComponent(setupReturnTo) + (setupResume ? '&resume=1' : '') : providerConnectionsPath(connection.provider) : '/account-selection?selection_id=' + connection.accountSelectionId}>{connection.accountSelectionUnavailable ? 'Restart selection' : `Choose ${noun}`}</Link> : <span className="inline-note">An owner or admin must finish selection.</span>}</div>)}</div>
  </section>;
}
