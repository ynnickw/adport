import { PageHeader } from '@/components/ui';
import { requireTenant } from '@/lib/auth';
import { getCloudStore } from '@/lib/store';

export const metadata = { title: 'Policies' };

export default async function PoliciesPage() {
  const tenant = await requireTenant();
  const policy = getCloudStore().policy(tenant.workspaceId);
  return (
    <main className="page">
      <PageHeader eyebrow="Structural safety" title="Policies" description="The active workspace policy passed into the shared policy engine. Editing arrives with governed writes." />
      <div className="grid-2">
        <section className="card">
          <div className="card-head"><h2>Active guardrails</h2><span className="status">Enforced</span></div>
          <div className="card-body policy-list">
            {Object.entries(policy).map(([key, value]) => (
              <div className="policy-row" key={key}>
                <span className="policy-key">{key.replaceAll('_', ' ')}</span>
                <span className="policy-value">{JSON.stringify(value)}</span>
              </div>
            ))}
          </div>
        </section>
        <aside className="card">
          <div className="card-head"><h2>Execution contract</h2></div>
          <div className="card-body">
            <div className="callout">Preview first → identical argument hash → explicit approval → single apply → append-only audit. Provider coercions are always visible.</div>
          </div>
        </aside>
      </div>
    </main>
  );
}
