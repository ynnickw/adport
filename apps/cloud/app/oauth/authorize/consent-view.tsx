import { PiCheckCircleFill, PiArrowSquareOut, PiArrowsLeftRight } from 'react-icons/pi';
import { AgentIdentityLogo } from '@/app/dashboard/agents/agent-setup-guide';
import { BrandLockup } from '@/components/logos';
import { Select } from '@/components/select';

export interface ConsentProject { id: string; name: string; organizationId: string; organizationName: string }

/** The consent screen: who is connecting, what it may do, which project, and where it returns. */
export function ConsentView({ clientName, redirectHost, scopes, projects, defaultProjectId, hidden }: {
  clientName: string;
  redirectHost: string;
  scopes: string[];
  projects: ConsentProject[];
  defaultProjectId?: string;
  hidden: Array<[string, string]>;
}) {
  const organizations = [...new Set(projects.map(project => project.organizationId))];
  const defaultProject = projects.find(project => project.id === defaultProjectId) ?? projects[0];
  const options = organizations.flatMap(id => {
    const members = projects.filter(project => project.organizationId === id);
    return [
      { value: `all:${id}`, label: 'All projects', group: members[0]!.organizationName },
      ...members.map(project => ({ value: project.id, label: project.name, group: project.organizationName })),
    ];
  });
  return (
    <div className="consent">
      <div className="consent-pair" aria-hidden="true">
        <AgentIdentityLogo name={clientName} />
        <PiArrowsLeftRight className="consent-link" />
        <BrandLockup />
      </div>
      <h1>Connect {clientName} to Adport</h1>
      <p className="consent-lede">Choose one project or all projects for {clientName}. Every change still goes through that project’s policy gate.</p>

      <ul className="consent-scopes" aria-label={`What ${clientName} can do`}>
        {scopes.includes('tools:read') ? <li><PiCheckCircleFill aria-hidden="true" /><span><strong>Read your ad accounts</strong>Accounts, campaigns and audit history.</span></li> : null}
        {scopes.includes('tools:write') ? <li><PiCheckCircleFill aria-hidden="true" /><span><strong>Propose changes</strong>Previews first. Only changes that pass the policy gate run.</span></li> : null}
      </ul>

      <form className="consent-form" method="post" action="/oauth/authorize/consent">
        {hidden.map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        <div className="field">
          <span className="field-label" id="consent-project-label">Project</span>
          <Select name="project_id" aria-label="Project" options={options} defaultValue={defaultProject ? `all:${defaultProject.organizationId}` : undefined} required />
          <span className="field-hint">All projects includes current and future projects you can access in that organization. New platforms become available when you connect them and enable their accounts.</span>
        </div>
        <p className="consent-return"><PiArrowSquareOut aria-hidden="true" /><span>Returns to <strong>{redirectHost}</strong>. Only continue if you started this connection there.</span></p>
        <div className="consent-actions">
          <button className="button" type="submit" name="decision" value="allow">Authorize {clientName}</button>
          <button className="button secondary" type="submit" name="decision" value="deny">Cancel</button>
        </div>
      </form>
      <p className="consent-foot">You can revoke this connection at any time.</p>
    </div>
  );
}
