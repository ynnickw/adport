import { Empty, PageHeader, formatDate } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { PostgresFindingsStore } from '@/lib/cloud/repository';
import { getAssistantConnectionStatus } from '@/lib/cloud/assistant-connection';
import { CopyButton } from '@/app/dashboard/agents/agent-setup-guide';
import { Disclosure } from '@/components/controls';
import { FindingsTable } from './findings-table';

export const metadata = { title: 'Findings' };

export default async function FindingsPage() {
  const tenant = await requireDashboardTenant();
  const findings = await new PostgresFindingsStore(tenant.organizationId).list();
  const assistant = findings.length === 0 ? await getAssistantConnectionStatus({ ...tenant, scopes: [] }).catch(() => undefined) : undefined;
  const prompt = 'Run an Adport audit of the enabled ad accounts in this project. Report findings only; don’t apply changes.';
  return (
    <main className="page">
      <PageHeader title="Findings" />
      <section className="card">
        {findings.length === 0 ? (
          assistant?.authorized ? <div className="empty">
            <h2>No findings yet</h2><p>Run an audit in your assistant to see what needs attention.</p>
            <CopyButton className="finding-prompt" value={prompt} label="Copy audit prompt" />
            <Disclosure className="finding-prompt-details" label="View prompt">{prompt}</Disclosure>
          </div> : <Empty title="No findings yet" copy={assistant ? 'Connect an assistant to run an audit.' : 'Run an audit in your assistant to see findings.'} href="/dashboard/agents" action={assistant ? 'Connect assistant' : 'View assistants'} />
        ) : (
          <FindingsTable key={tenant.organizationId} findings={findings.map(({ id, title, detail, recommendation, severity, provider, accountId, entity, status, updatedAt }) =>
            ({ id, title, detail, recommendation, severity, provider, accountId, entity, status, updatedAt, updatedLabel: formatDate(updatedAt) }))} />
        )}
      </section>
    </main>
  );
}
