import type { ReactNode } from 'react';
import { DataCell, DataTable } from './data-table';

export function PeopleTable({ rows }: { rows: Array<{ id: string; name: string; email: string; isSelf: boolean; role: ReactNode; access: ReactNode; action?: ReactNode }> }) {
  return <DataTable responsive className="people-table" columns={['Person', 'Role', 'Project access', { label: <span className="sr-only">Actions</span> }]}>
    {rows.map(row => <tr key={row.id}>
      <DataCell label="Person"><div className="identity"><span className="avatar" aria-hidden="true">{row.name.slice(0, 1).toUpperCase()}</span><div><strong>{row.name}{row.isSelf ? ' · you' : ''}</strong><div className="person-email">{row.email}</div></div></div></DataCell>
      <DataCell label="Role">{row.role}</DataCell>
      <DataCell label="Project access">{row.access}</DataCell>
      <DataCell label="Actions">{row.action}</DataCell>
    </tr>)}
  </DataTable>;
}
