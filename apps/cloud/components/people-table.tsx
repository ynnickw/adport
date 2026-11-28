import type { ReactNode } from 'react';
import { DataCell, DataTable } from './data-table';
import { ProfileIdentity } from './profile-identity';

export function PeopleTable({ rows }: { rows: Array<{ id: string; name: string; email: string; avatarUrl?: string | null; isSelf: boolean; role: ReactNode; access: ReactNode; action?: ReactNode }> }) {
  return <DataTable responsive className="people-table" columns={['Person', 'Role', 'Project access', { label: <span className="sr-only">Actions</span>, align: 'end' }]}>
    {rows.map(row => <tr key={row.id}>
      <DataCell label="Person"><ProfileIdentity name={row.name} email={row.email} avatarUrl={row.avatarUrl} isSelf={row.isSelf} /></DataCell>
      <DataCell label="Role">{row.role}</DataCell>
      <DataCell label="Project access">{row.access}</DataCell>
      <DataCell label="Actions">{row.action}</DataCell>
    </tr>)}
  </DataTable>;
}
