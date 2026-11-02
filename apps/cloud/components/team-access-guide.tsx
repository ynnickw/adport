import { Disclosure } from './controls';
import { TEAM_ROLES } from '@/lib/team-roles';

export function TeamAccessGuide() {
  return <Disclosure label="Roles and project access">
    <p className="inline-note">People in the same project share its accounts, reports, approvals, and history. Roles control what they can change. Use separate projects for brands, departments, or clients that need separate access.</p>
    <div className="table-wrap"><table>
      <caption className="sr-only">Organization roles and project permissions</caption>
      <thead><tr><th>Role</th><th>Project access</th><th>Permissions</th></tr></thead>
      <tbody>{Object.entries(TEAM_ROLES).map(([role, details]) => <tr key={role}>
        <th scope="row">{details.label}</th>
        <td>{role === 'owner' || role === 'admin' ? 'All current and future projects' : 'Assigned projects only'}</td>
        <td>{details.description}</td>
      </tr>)}</tbody>
    </table></div>
  </Disclosure>;
}
