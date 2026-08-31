import 'server-only';
import type { Account } from '@adport/core';
import { db } from '@/lib/db';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { safeReturnPath } from '@/lib/return-path';
import type { CloudProvider, TenantPrincipal } from './types';
import { providerLabel } from './providers';

interface SelectionRow {
  id: string;
  connectionId: string;
  provider: CloudProvider;
  ciphertext: string;
  returnPath: string;
}

function requireManager(principal: TenantPrincipal) {
  if (!principal.userId || !['owner', 'admin'].includes(principal.role ?? '')) {
    throw new Error('Owner or admin access is required.');
  }
}

const aad = (organizationId: string, id: string) => `account-selection:${organizationId}:${id}`;

/** Only the OAuth callback may create a discovery snapshot; it is never inventory. */
export async function stageAccountSelection(input: {
  principal: TenantPrincipal;
  id: string;
  connectionId: string;
  provider: CloudProvider;
  accounts: Account[];
  returnPath: string;
}): Promise<void> {
  requireManager(input.principal);
  const accounts = [...new Map(input.accounts.map(account => [account.id, {
    provider: input.provider, id: account.id, name: account.name || account.id,
    currency: account.currency, status: account.status,
  }])).values()];
  await db().begin(async sql => {
    const connections = await sql`
      select id from public.connections where id = ${input.connectionId}
        and organization_id = ${input.principal.organizationId} and provider = ${input.provider}
        and account_selection_id = ${input.id} and status = 'connected' for update
    `;
    if (!connections.length) throw new Error('This authorization has been replaced. Re-authorize to choose accounts.');
    await sql`
      insert into private.provider_account_selections
        (id, organization_id, connection_id, provider, user_id, ciphertext, return_path)
      values (${input.id}, ${input.principal.organizationId}, ${input.connectionId}, ${input.provider},
        ${input.principal.userId!}, ${encryptSecret(accounts, aad(input.principal.organizationId, input.id))},
        ${safeReturnPath(input.returnPath)})
    `;
  });
}

export async function getAccountSelection(principal: TenantPrincipal, id: string) {
  requireManager(principal);
  const rows = await db()<SelectionRow[]>`
    select selection.id, selection.connection_id, selection.provider, selection.ciphertext, selection.return_path
    from private.provider_account_selections selection
    join public.connections connection on connection.id = selection.connection_id
      and connection.account_selection_id = selection.id
    where selection.id = ${id} and selection.organization_id = ${principal.organizationId}
      and selection.user_id = ${principal.userId!} and selection.expires_at > now()
      and connection.status = 'connected'
  `;
  const row = rows[0];
  if (!row) return undefined;
  return { id: row.id, provider: row.provider, accounts: decryptSecret<Account[]>(row.ciphertext, aad(principal.organizationId, id)) };
}

/** Commit a subset atomically, then destroy the full discovery snapshot. */
export async function saveAccountSelection(principal: TenantPrincipal, id: string, accountIds: string[]) {
  requireManager(principal);
  return db().begin(async sql => {
    // Serialize inventory changes with account activation and other selections.
    await sql`select id from public.organizations where id = ${principal.organizationId} for update`;
    const rows = await sql<SelectionRow[]>`
      select selection.id, selection.connection_id, selection.provider, selection.ciphertext, selection.return_path
      from private.provider_account_selections selection
      join public.connections connection on connection.id = selection.connection_id
        and connection.account_selection_id = selection.id
      where selection.id = ${id} and selection.organization_id = ${principal.organizationId}
        and selection.user_id = ${principal.userId!} and selection.expires_at > now()
        and connection.status = 'connected'
      for update of connection, selection
    `;
    const row = rows[0];
    if (!row) throw new Error('This account selection has expired or was already saved. Re-authorize to choose accounts again.');
    const accounts = decryptSecret<Account[]>(row.ciphertext, aad(principal.organizationId, id));
    const selectedIds = new Set(accountIds);
    if (selectedIds.size !== accountIds.length || accountIds.some(value => !accounts.some(account => account.id === value))) {
      throw new Error('Only accounts returned by this authorization may be added.');
    }
    const selected = accounts.filter(account => selectedIds.has(account.id));
    await sql`
      delete from public.organization_ad_accounts where organization_id = ${principal.organizationId}
        and provider = ${row.provider} and not (account_id = any(${accountIds}::text[]))
    `;
    for (const account of selected) {
      await sql`
        insert into public.organization_ad_accounts
          (organization_id, connection_id, provider, account_id, name, currency, status)
        values (${principal.organizationId}, ${row.connectionId}, ${row.provider}, ${account.id},
          ${account.name}, ${account.currency ?? null}, ${account.status ?? null})
        on conflict (organization_id, provider, account_id) do update set
          connection_id = excluded.connection_id, name = excluded.name, currency = excluded.currency,
          status = excluded.status, last_seen_at = now()
      `;
    }
    await sql`
      update public.connections set account_selection_id = null, external_subject = null,
        external_label = ${`${selected.length} added ${providerLabel(row.provider)} account(s)`}
      where id = ${row.connectionId} and organization_id = ${principal.organizationId}
    `;
    await sql`delete from private.provider_account_selections where id = ${id} and organization_id = ${principal.organizationId}`;
    await sql`
      insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary, details)
      values (${principal.organizationId}, ${principal.userId!}, 'account_access_updated', ${row.provider},
        'account_selection_save', '*', ${`Added ${selected.length} selected ${providerLabel(row.provider)} account(s)`},
        ${sql.json({ selectedAccountIds: accountIds } as never)})
    `;
    const returnUrl = new URL(safeReturnPath(row.returnPath), 'https://adport.invalid');
    returnUrl.searchParams.delete('connected');
    returnUrl.searchParams.set('accounts_saved', row.provider);
    return { returnPath: `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`, count: selected.length };
  });
}
