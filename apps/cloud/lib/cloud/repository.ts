import 'server-only';
import { randomBytes } from 'node:crypto';
import type { AuditEntry, PendingOperation, Policy } from '@adport/core';
import { policySchema } from '@adport/core';
import { db } from '@/lib/db';
import { decryptSecret, digestApiKey, digestState, encryptSecret } from '@/lib/crypto';
import type {
  CloudProvider,
  OAuthProvider,
  ProviderCredentialMap,
  StoredGoogleCredential,
  StoredProviderCredential,
  TenantPrincipal,
} from './types';

interface MembershipRow {
  organizationId: string;
  role: TenantPrincipal['role'];
}

export async function resolveMembership(userId: string, requestedOrganizationId?: string): Promise<MembershipRow> {
  const sql = db();
  const rows = requestedOrganizationId
    ? await sql<MembershipRow[]>`
        select organization_id, role
        from public.organization_memberships
        where user_id = ${userId} and organization_id = ${requestedOrganizationId}
        limit 1
      `
    : await sql<MembershipRow[]>`
        select organization_id, role
        from public.organization_memberships
        where user_id = ${userId}
        order by created_at asc
        limit 1
      `;
  const membership = rows[0];
  if (!membership) throw new Error('You do not have access to this organization.');
  return membership;
}

export async function getOrganizationPolicy(organizationId: string): Promise<Policy> {
  const rows = await db()<Array<{ policy: unknown }>>`
    select policy from public.organization_settings where organization_id = ${organizationId}
  `;
  return policySchema.parse(rows[0]?.policy ?? {});
}

export async function createOAuthTransaction(input: {
  organizationId: string;
  userId: string;
  provider: OAuthProvider;
  state: string;
  verifier: string;
  returnPath?: string;
}): Promise<void> {
  const aad = `oauth:${input.organizationId}:${input.userId}:${input.provider}`;
  await db()`
    insert into private.oauth_transactions
      (organization_id, user_id, provider, state_hash, verifier_ciphertext, return_path, expires_at)
    values
      (${input.organizationId}, ${input.userId}, ${input.provider}, ${digestState(input.state)},
       ${encryptSecret({ verifier: input.verifier }, aad)}, ${input.returnPath ?? '/dashboard/connections'}, now() + interval '10 minutes')
  `;
}

export async function consumeOAuthTransaction(provider: OAuthProvider, state: string, userId: string): Promise<{
  organizationId: string;
  verifier: string;
  returnPath: string;
}> {
  return db().begin(async (sql) => {
    const rows = await sql<Array<{
      id: string;
      organizationId: string;
      userId: string;
      verifierCiphertext: string;
      returnPath: string;
      expiresAt: Date;
      consumedAt: Date | null;
    }>>`
      select id, organization_id, user_id, verifier_ciphertext, return_path, expires_at, consumed_at
      from private.oauth_transactions
      where state_hash = ${digestState(state)} and provider = ${provider}
      for update
    `;
    const transaction = rows[0];
    if (!transaction || transaction.userId !== userId || transaction.consumedAt || transaction.expiresAt.getTime() <= Date.now()) {
      throw new Error('OAuth state is invalid, expired, or already used.');
    }
    await sql`update private.oauth_transactions set consumed_at = now() where id = ${transaction.id}`;
    const aad = `oauth:${transaction.organizationId}:${userId}:${provider}`;
    const secret = decryptSecret<{ verifier: string }>(transaction.verifierCiphertext, aad);
    return { organizationId: transaction.organizationId, verifier: secret.verifier, returnPath: transaction.returnPath };
  });
}

export async function upsertGoogleConnection(input: {
  organizationId: string;
  userId: string;
  refreshToken: string;
  accessibleCustomerIds: string[];
  loginCustomerId?: string;
}): Promise<string> {
  return upsertProviderConnection({
    organizationId: input.organizationId,
    userId: input.userId,
    provider: 'google',
    credential: { refreshToken: input.refreshToken, loginCustomerId: input.loginCustomerId },
    externalSubject: input.accessibleCustomerIds.join(','),
    externalLabel: `${input.accessibleCustomerIds.length} accessible Google Ads account(s)`,
    scopes: ['https://www.googleapis.com/auth/adwords'],
  });
}

export async function upsertProviderConnection<P extends CloudProvider>(input: {
  organizationId: string;
  userId: string;
  provider: P;
  credential: ProviderCredentialMap[P];
  externalSubject?: string;
  externalLabel?: string;
  scopes?: string[];
}): Promise<string> {
  return db().begin(async (sql) => {
    const rows = await sql<Array<{ id: string }>>`
      insert into public.connections
        (organization_id, provider, status, external_subject, external_label, scopes, connected_by, last_verified_at, last_error, revoked_at)
      values
        (${input.organizationId}, ${input.provider}, 'connected', ${input.externalSubject ?? null},
         ${input.externalLabel ?? `${input.provider} connection`},
         ${input.scopes ?? []}, ${input.userId}, now(), null, null)
      on conflict (organization_id, provider) do update set
        status = 'connected',
        external_subject = excluded.external_subject,
        external_label = excluded.external_label,
        scopes = excluded.scopes,
        connected_by = excluded.connected_by,
        connected_at = now(),
        last_verified_at = now(),
        last_error = null,
        revoked_at = null
      returning id
    `;
    const connectionId = rows[0]!.id;
    const aad = `connection:${input.organizationId}:${input.provider}`;
    await sql`
      insert into private.provider_credentials (connection_id, organization_id, provider, ciphertext)
      values (${connectionId}, ${input.organizationId}, ${input.provider}, ${encryptSecret(input.credential, aad)})
      on conflict (connection_id) do update set ciphertext = excluded.ciphertext, key_version = 1, updated_at = now()
    `;
    return connectionId;
  });
}

export async function loadGoogleCredential(organizationId: string): Promise<(StoredGoogleCredential & { connectionId: string }) | undefined> {
  return loadProviderCredential(organizationId, 'google');
}

export async function loadProviderCredential<P extends CloudProvider>(
  organizationId: string,
  provider: P,
): Promise<(ProviderCredentialMap[P] & { connectionId: string }) | undefined> {
  const rows = await db()<Array<{ connectionId: string; ciphertext: string }>>`
    select connection_id, ciphertext
    from private.provider_credentials
    where organization_id = ${organizationId} and provider = ${provider}
    limit 1
  `;
  const row = rows[0];
  if (!row) return undefined;
  return {
    connectionId: row.connectionId,
    ...decryptSecret<ProviderCredentialMap[P]>(row.ciphertext, `connection:${organizationId}:${provider}`),
  };
}

export async function loadProviderCredentials(organizationId: string): Promise<Partial<{
  [P in CloudProvider]: ProviderCredentialMap[P] & { connectionId: string };
}>> {
  const rows = await db()<Array<{ connectionId: string; provider: CloudProvider; ciphertext: string }>>`
    select credential.connection_id, credential.provider, credential.ciphertext
    from private.provider_credentials credential
    join public.connections connection on connection.id = credential.connection_id
    where credential.organization_id = ${organizationId} and connection.status = 'connected'
  `;
  const credentials: Partial<Record<CloudProvider, StoredProviderCredential & { connectionId: string }>> = {};
  for (const row of rows) {
    credentials[row.provider] = {
      connectionId: row.connectionId,
      ...decryptSecret<StoredProviderCredential>(row.ciphertext, `connection:${organizationId}:${row.provider}`),
    };
  }
  return credentials as Partial<{ [P in CloudProvider]: ProviderCredentialMap[P] & { connectionId: string } }>;
}

export async function updateProviderCredential<P extends CloudProvider>(
  organizationId: string,
  provider: P,
  credential: ProviderCredentialMap[P],
): Promise<void> {
  const rows = await db()<Array<{ connectionId: string }>>`
    update private.provider_credentials
    set ciphertext = ${encryptSecret(credential, `connection:${organizationId}:${provider}`)}, updated_at = now()
    where organization_id = ${organizationId} and provider = ${provider}
    returning connection_id
  `;
  if (rows.length !== 1) throw new Error(`No ${provider} connection exists for credential rotation.`);
}

export async function setConnectionVerification(
  organizationId: string,
  provider: CloudProvider,
  result: { ok: true; label: string; subject?: string } | { ok: false; error: string },
): Promise<void> {
  if (result.ok) {
    await db()`
      update public.connections set status = 'connected', external_label = ${result.label},
        external_subject = ${result.subject ?? null}, last_verified_at = now(), last_error = null, revoked_at = null
      where organization_id = ${organizationId} and provider = ${provider}
    `;
  } else {
    await db()`
      update public.connections set status = 'error', last_error = ${result.error}, last_verified_at = now()
      where organization_id = ${organizationId} and provider = ${provider}
    `;
  }
}

export async function removeProviderConnection(
  organizationId: string,
  provider: CloudProvider,
  connectionId: string,
): Promise<boolean> {
  const rows = await db()<Array<{ id: string }>>`
    delete from public.connections
    where id = ${connectionId} and organization_id = ${organizationId} and provider = ${provider}
    returning id
  `;
  return rows.length === 1;
}

export async function removeGoogleConnection(organizationId: string, connectionId: string): Promise<boolean> {
  return removeProviderConnection(organizationId, 'google', connectionId);
}

export async function recordAudit(
  principal: TenantPrincipal,
  entry: {
    event: AuditEntry['event'] | 'connected' | 'revoked' | 'api_key_created' | 'api_key_revoked'
      | 'member_invited' | 'member_role_updated' | 'member_removed' | 'settings_updated' | 'deletion_requested';
    provider: string;
    tool: string;
    accountId: string;
    pendingId?: string;
    summary: string;
    details?: unknown;
  },
): Promise<void> {
  await db()`
    insert into public.audit_events
      (organization_id, actor_user_id, api_key_id, event, provider, tool, account_id, pending_id, summary, details)
    values
      (${principal.organizationId}, ${principal.userId ?? null}, ${principal.apiKeyId ?? null}, ${entry.event},
       ${entry.provider}, ${entry.tool}, ${entry.accountId}, ${entry.pendingId ?? null}, ${entry.summary},
       ${entry.details === undefined ? null : db().json(entry.details as never)})
  `;
}

export async function createApiKey(input: {
  organizationId: string;
  userId: string;
  name: string;
  scopes: string[];
}): Promise<{ id: string; key: string; prefix: string }> {
  const key = `adp_${randomBytes(32).toString('base64url')}`;
  const prefix = key.slice(0, 12);
  return db().begin(async (sql) => {
    const rows = await sql<Array<{ id: string }>>`
      insert into public.api_keys (organization_id, name, key_prefix, secret_hash, scopes, created_by)
      values (${input.organizationId}, ${input.name}, ${prefix}, ${digestApiKey(key)}, ${input.scopes}, ${input.userId})
      returning id
    `;
    const id = rows[0]!.id;
    await sql`
      insert into public.audit_events
        (organization_id, actor_user_id, event, provider, tool, account_id, summary)
      values (${input.organizationId}, ${input.userId}, 'api_key_created', 'cloud', 'api_key_create', '*',
        ${`Created API key ${prefix}…`})
    `;
    return { id, key, prefix };
  });
}

export async function authenticateApiKey(key: string): Promise<TenantPrincipal | undefined> {
  if (!/^adp_[A-Za-z0-9_-]{40,}$/.test(key)) return undefined;
  const rows = await db()<Array<{
    id: string;
    organizationId: string;
    scopes: string[];
    expiresAt: Date | null;
  }>>`
    select id, organization_id, scopes, expires_at
    from public.api_keys
    where secret_hash = ${digestApiKey(key)} and revoked_at is null
    limit 1
  `;
  const found = rows[0];
  if (!found || (found.expiresAt && found.expiresAt.getTime() <= Date.now())) return undefined;
  await db()`update public.api_keys set last_used_at = now() where id = ${found.id}`;
  return { organizationId: found.organizationId, apiKeyId: found.id, scopes: found.scopes };
}

export async function revokeApiKey(principal: TenantPrincipal, id: string): Promise<boolean> {
  return db().begin(async (sql) => {
    const rows = await sql<Array<{ id: string }>>`
      update public.api_keys set revoked_at = now()
      where id = ${id} and organization_id = ${principal.organizationId} and revoked_at is null
      returning id
    `;
    if (rows.length) {
      await sql`
        insert into public.audit_events
          (organization_id, actor_user_id, api_key_id, event, provider, tool, account_id, summary)
        values (${principal.organizationId}, ${principal.userId ?? null}, ${principal.apiKeyId ?? null},
          'api_key_revoked', 'cloud', 'api_key_revoke', '*', ${`Revoked API key ${id}`})
      `;
    }
    return rows.length === 1;
  });
}

export async function enforceRateLimit(subject: string, limit = 120, windowSeconds = 60): Promise<boolean> {
  const subjectHash = digestState(subject);
  const rows = await db()<Array<{ requestCount: number }>>`
    insert into private.rate_limit_buckets (subject_hash, window_start, request_count)
    values (${subjectHash}, date_trunc('minute', now()), 1)
    on conflict (subject_hash, window_start) do update
      set request_count = private.rate_limit_buckets.request_count + 1
      where private.rate_limit_buckets.request_count < ${limit}
    returning request_count
  `;
  if (Math.random() < 0.01) {
    await db()`delete from private.rate_limit_buckets where window_start < now() - (${windowSeconds * 10} * interval '1 second')`;
  }
  return rows.length === 1;
}

export class PostgresPendingStore {
  constructor(private readonly principal: TenantPrincipal) {}

  async put(operation: PendingOperation): Promise<void> {
    await db()`
      insert into public.pending_operations
        (id, organization_id, provider, operation_hash, operation, preview, created_by, created_at, expires_at)
      values
        (${operation.id}, ${this.principal.organizationId}, ${operation.provider}, ${operation.opHash},
         ${db().json(operation.op as never)}, ${db().json(operation.preview as never)},
         ${this.principal.userId ?? null}, ${operation.createdAt}, ${operation.expiresAt})
    `;
  }

  async get(id: string): Promise<PendingOperation | undefined> {
    const rows = await db()<Array<{
      id: string;
      provider: string;
      operationHash: string;
      operation: PendingOperation['op'];
      preview: PendingOperation['preview'];
      createdAt: Date;
      expiresAt: Date;
    }>>`
      select id, provider, operation_hash, operation, preview, created_at, expires_at
      from public.pending_operations
      where id = ${id} and organization_id = ${this.principal.organizationId} and consumed_at is null
      limit 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      provider: row.provider,
      opHash: row.operationHash,
      op: row.operation,
      preview: row.preview,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async delete(id: string): Promise<void> {
    await db()`
      update public.pending_operations set consumed_at = now()
      where id = ${id} and organization_id = ${this.principal.organizationId}
    `;
  }

  async sweep(now = new Date()): Promise<void> {
    await db()`
      update public.pending_operations set consumed_at = ${now.toISOString()}
      where organization_id = ${this.principal.organizationId} and consumed_at is null and expires_at < ${now.toISOString()}
    `;
  }
}

export class PostgresAuditStore {
  constructor(private readonly principal: TenantPrincipal) {}

  async append(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
    await recordAudit(this.principal, entry);
  }
}

export interface ConnectionSummary {
  id: string;
  provider: CloudProvider;
  status: 'connected' | 'error' | 'revoked';
  externalLabel: string | null;
  lastError: string | null;
  scopes: string[];
  connectedAt: Date;
  lastVerifiedAt: Date | null;
}

export async function listConnections(organizationId: string): Promise<ConnectionSummary[]> {
  return db()<ConnectionSummary[]>`
    select id, provider, status, external_label, last_error, scopes, connected_at, last_verified_at
    from public.connections
    where organization_id = ${organizationId}
    order by connected_at asc
  `;
}

export interface PendingOperationRow {
  id: string;
  provider: string;
  operationHash: string;
  operation: PendingOperation['op'];
  preview: PendingOperation['preview'];
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export async function listPendingOperations(organizationId: string, limit = 50): Promise<PendingOperationRow[]> {
  return db()<PendingOperationRow[]>`
    select id, provider, operation_hash, operation, preview, created_by, created_at, expires_at, consumed_at
    from public.pending_operations
    where organization_id = ${organizationId} and consumed_at is null and expires_at > now()
    order by created_at desc
    limit ${limit}
  `;
}

export interface AuditEventRow {
  id: string;
  event: string;
  provider: string;
  tool: string;
  accountId: string;
  pendingId: string | null;
  summary: string;
  actorUserId: string | null;
  apiKeyId: string | null;
  createdAt: Date;
}

export async function listAuditEvents(organizationId: string, limit = 100): Promise<AuditEventRow[]> {
  return db()<AuditEventRow[]>`
    select id, event, provider, tool, account_id, pending_id, summary, actor_user_id, api_key_id, created_at
    from public.audit_events
    where organization_id = ${organizationId}
    order by created_at desc
    limit ${limit}
  `;
}

export async function countAuditEvents(organizationId: string): Promise<number> {
  const rows = await db()<Array<{ count: number }>>`
    select count(*)::int as count from public.audit_events where organization_id = ${organizationId}
  `;
  return rows[0]?.count ?? 0;
}
