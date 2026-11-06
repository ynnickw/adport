import 'server-only';
import { AdportError } from '@adport/core';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import type { TenantPrincipal } from './types';

/** Account selection deliberately withholds credentials, including after a reconnect. */
export async function rejectUnavailableGtm(principal: TenantPrincipal, write: boolean): Promise<never> {
  const [connection] = await db()<Array<{ status: string; selectionPending: boolean; projectName: string }>>`
    select connection.status, connection.account_selection_id is not null as selection_pending,
      project.name as project_name
    from public.connections connection
    join public.organizations project on project.id = connection.organization_id
    where connection.organization_id = ${principal.organizationId} and connection.provider = 'gtm'
  `;
  const kind = connection?.selectionPending ? 'account_selection'
    : connection?.status === 'connected' ? 'connection_changed' : 'reconnect';
  const project = connection?.projectName ? ` in ${connection.projectName}` : ' in this project';
  const message = kind === 'account_selection'
    ? `Google Tag Manager is waiting for account selection${project}. Finish selecting accounts in Analytics & tracking, then refresh the preview.`
    : kind === 'connection_changed'
      ? `The Google Tag Manager connection changed while this request was starting${project}. Refresh the preview to check the current connection.`
      : `Reconnect Google Tag Manager${project} in Analytics & tracking, finish account selection, then request a fresh preview.`;
  throw new AdportError('NOT_CONNECTED', message + (write ? ' No write was started.' : ''), {
    ...(write ? { apply_state: 'NOT_STARTED' } : {}),
    connection_recovery: {
      kind, project_id: principal.organizationId,
      dashboard_url: new URL('/dashboard/analytics', env().ADPORT_CLOUD_BASE_URL).href,
    },
  });
}
