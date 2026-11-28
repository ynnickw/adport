'use client';

import { useId, useState } from 'react';
import { PiCheckCircleFill, PiArrowSquareOut, PiArrowsLeftRight } from 'react-icons/pi';
import { AgentIdentityLogo } from '@/app/dashboard/agents/agent-setup-guide';
import { BrandLockup } from '@/components/logos';
import { Button, Checkbox } from '@/components/controls';
import { InfoTooltip } from '@/components/info-tooltip';
import { Select } from '@/components/select';
import { ToolCatalogFields } from '@/components/tool-catalog-fields';
import type { ToolProvider } from '@adport/core/tool-catalog';

export interface ConsentProject { id: string; name: string; organizationId: string; organizationName: string; providers?: ToolProvider[] }

/** The consent screen: who is connecting, what it may do, which project, and where it returns. */
export function ConsentView({ clientName, redirectHost, scopes, projects, defaultProjectId, hidden }: {
  clientName: string;
  redirectHost: string;
  scopes: string[];
  projects: ConsentProject[];
  defaultProjectId?: string;
  hidden: Array<[string, string]>;
}) {
  const workspaceLabel = useId();
  const organizations = new Map<string, { name: string; projects: ConsentProject[] }>();
  for (const project of projects) {
    const group = organizations.get(project.organizationId);
    if (group) group.projects.push(project);
    else organizations.set(project.organizationId, { name: project.organizationName, projects: [project] });
  }
  const defaultProject = projects.find(project => project.id === defaultProjectId) ?? projects[0];
  const organizationOptions = [...organizations].sort(([leftId, left], [rightId, right]) =>
    Number(rightId === defaultProject?.organizationId) - Number(leftId === defaultProject?.organizationId) || left.name.localeCompare(right.name));
  const [accessScope, setAccessScope] = useState<'organizations' | 'project'>('organizations');
  const [organizationIds, setOrganizationIds] = useState(defaultProject ? [defaultProject.organizationId] : []);
  const [projectId, setProjectId] = useState(defaultProject?.id ?? '');
  const selectedProjects = projects.filter(project => accessScope === 'organizations' ? organizationIds.includes(project.organizationId) : project.id === projectId);
  const suggestedProviders = [...new Set(selectedProjects.flatMap(project => project.providers ?? []))];
  const allSelected = organizationIds.length === organizations.size;
  const projectOptions = [...organizations.values()].flatMap(group => group.projects.map(project => ({ value: project.id, label: project.name, group: group.name })));
  return (
    <div className="consent">
      <div className="consent-pair" aria-hidden="true">
        <AgentIdentityLogo name={clientName} />
        <PiArrowsLeftRight className="consent-link" />
        <BrandLockup />
      </div>
      <h1>Connect {clientName} to Adport</h1>

      <ul className="consent-scopes" aria-label={`What ${clientName} can do`}>
        {scopes.includes('tools:read') ? <li><PiCheckCircleFill aria-hidden="true" /><strong>Read your ad accounts</strong><InfoTooltip label="About reading ad accounts">View enabled accounts, campaigns and audit history in each authorized project.</InfoTooltip></li> : null}
        {scopes.includes('tools:write') ? <li><PiCheckCircleFill aria-hidden="true" /><strong>Propose and apply changes</strong><InfoTooltip label="About ad changes">Ad changes require a preview and project approval. Your role, plan and safeguards apply in each project.</InfoTooltip></li> : null}
      </ul>

      <form className="consent-form" method="post" action="/oauth/authorize/consent">
        {hidden.map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        <fieldset className="consent-workspace-access" aria-labelledby={workspaceLabel}>
          <legend><span className="field-label"><span id={workspaceLabel}>Workspace access</span><InfoTooltip label="About workspace access">Organization access covers current and future projects you can access in the selected organizations. Select all includes the organizations listed here.</InfoTooltip></span></legend>
          <div className="consent-scope-options">
            <label className="assistant-radio-card"><input type="radio" name="access_scope" value="organizations" checked={accessScope === 'organizations'} onChange={() => setAccessScope('organizations')} /><span>Organizations</span></label>
            <label className="assistant-radio-card"><input type="radio" name="access_scope" value="project" checked={accessScope === 'project'} onChange={() => setAccessScope('project')} /><span>One project</span></label>
          </div>
          {accessScope === 'organizations' ? <div className="consent-org-picker">
            {organizations.size > 1 ? <div className="consent-org-toolbar"><span>{organizationIds.length} of {organizations.size} selected</span><Button type="button" className="link-button" onClick={() => setOrganizationIds(allSelected ? [] : [...organizations.keys()])}>{allSelected ? 'Clear selection' : 'Select all'}</Button></div> : null}
            <div className="consent-org-list">
              {organizationOptions.map(([id, group]) => <label className="consent-org-option" key={id}>
                <Checkbox name="organization_ids" value={id} checked={organizationIds.includes(id)} onChange={event => {
                  const checked = event.target.checked;
                  setOrganizationIds(current => checked ? [...current, id] : current.filter(value => value !== id));
                }} />
                <span>{group.name}</span><small>{group.projects.length} {group.projects.length === 1 ? 'project' : 'projects'}</small>
              </label>)}
            </div>
          </div> : <Select name="project_id" aria-label="Project" options={projectOptions} value={projectId} onValueChange={setProjectId} required />}
          {!projects.length ? <p className="field-hint">You need access to an Adport project before connecting an assistant.</p> : null}
        </fieldset>
        <ToolCatalogFields initialSelection={{ profile: 'standard', providers: suggestedProviders }} />
        <p className="consent-return"><PiArrowSquareOut aria-hidden="true" /><span>Returns to <strong>{redirectHost}</strong>. Only continue if you started this connection there.</span></p>
        <div className="consent-actions">
          <button className="button" type="submit" name="decision" value="allow" disabled={!selectedProjects.length || !scopes.length}>Authorize {clientName}</button>
          <button className="button secondary" type="submit" name="decision" value="deny">Cancel</button>
        </div>
      </form>
      <p className="consent-foot">You can revoke this connection at any time.</p>
    </div>
  );
}
