import type { ComponentProps, ReactNode } from 'react';

type Column = string | { label: ReactNode; align?: 'end'; id?: string };

export function DataTable({ columns, children, responsive = false, className = '', busy, label }: {
  columns: readonly Column[];
  children: ReactNode;
  responsive?: boolean;
  className?: string;
  busy?: boolean;
  label?: string;
}) {
  return <div className="table-wrap" aria-busy={busy}>
    <table className={`${responsive ? 'stack-on-mobile' : ''} ${className}`} aria-label={label}>
      <thead><tr>{columns.map((column, index) => typeof column === 'string'
        ? <th key={column} scope="col">{column}</th>
        : <th key={column.id ?? index} scope="col" className={column.align === 'end' ? 'numeric' : undefined}>{column.label}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>;
}

export function DataCell({ label, numeric, className = '', ...props }: ComponentProps<'td'> & { label: string; numeric?: boolean }) {
  return <td {...props} data-label={label} className={`${numeric ? 'numeric' : ''} ${className}`} />;
}
