import { runAudit } from '@/app/actions';
import { Empty, PageHeader, Provider } from '@/components/ui';
import { requireTenant } from '@/lib/auth';
import { getCloudStore } from '@/lib/store';

export const metadata = { title: 'Findings' };
export const dynamic = 'force-dynamic';

export default async function FindingsPage() {
  const tenant = await requireTenant();
  const findings = await getCloudStore().findings(tenant.workspaceId).list({ status: 'open' });
  return (
    <main className="page">
      <PageHeader eyebrow="Recommendation harness" title="Findings" description="Evidence-backed rule results. There is deliberately no gameable optimization score." action={<form action={runAudit}><button className="button" type="submit">Run audit</button></form>} />
      <section className="card">
        {findings.length === 0 ? <Empty title="No open findings" copy="Run an audit after connecting accounts. Scheduled work will create findings and proposals, never silent changes." /> : (
          <>
            <div className="card-head"><h2>Open findings</h2><span className="card-note">{findings.length} open</span></div>
            {findings.map((finding) => (
              <article className="finding" key={finding.id}>
                <div className="finding-top">
                  <span className={`status ${finding.severity}`}>{finding.severity}</span>
                  <Provider name={finding.provider} />
                  <span className="card-note">{finding.entity.name}</span>
                </div>
                <h3>{finding.title}</h3>
                <p>{finding.detail}</p>
                <p><strong>Recommendation:</strong> {finding.recommendation}</p>
              </article>
            ))}
          </>
        )}
      </section>
    </main>
  );
}
