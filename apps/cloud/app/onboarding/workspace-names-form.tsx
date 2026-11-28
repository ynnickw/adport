import { useId } from 'react';
import { Input } from '@/components/controls';
import { WorkspaceForm } from '@/components/workspace-form';
import { saveWorkspaceNamesAction } from './actions';

export function WorkspaceNamesForm({ projectId, organizationName, projectName, returnTo, advance = false }: {
  projectId: string;
  organizationName: string;
  projectName: string;
  returnTo: string;
  advance?: boolean;
}) {
  const organizationNameId = useId();
  const projectNameId = useId();
  return <WorkspaceForm action={saveWorkspaceNamesAction} label={advance ? 'Continue to platforms' : 'Save names'}>
    <input type="hidden" name="projectId" value={projectId} />
    <input type="hidden" name="return_to" value={returnTo} />
    {advance ? <input type="hidden" name="advance" value="1" /> : null}
    <div className="workspace-name-fields">
      <div className="field">
        <label htmlFor={organizationNameId}>Organization name</label>
        <Input id={organizationNameId} name="organizationName" defaultValue={organizationName} autoComplete="organization"
          aria-describedby={`${organizationNameId}-hint`} maxLength={120} required />
        <span id={`${organizationNameId}-hint`} className="field-hint">Your company or team.</span>
      </div>
      <div className="field">
        <label htmlFor={projectNameId}>First project name</label>
        <Input id={projectNameId} name="projectName" defaultValue={projectName} aria-describedby={`${projectNameId}-hint`} maxLength={120} required />
        <span id={`${projectNameId}-hint`} className="field-hint">For a brand, client, or set of ad accounts.</span>
      </div>
    </div>
  </WorkspaceForm>;
}
