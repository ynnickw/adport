import 'server-only';
import {
  AdportError,
  type AdProvider,
  type AnyToolDefinition,
  type NormalizedQuery,
  type WriteGuard,
  type WriteOperation,
} from '@adport/core';
import type { CloudProvider } from './types';

function canonicalAccountId(provider: string, accountId: string): string {
  if (provider === 'google') return accountId.replaceAll('-', '');
  if (provider === 'meta') return accountId.replace(/^act_/, '');
  return accountId;
}

function assertAllowed(providerId: string, allowed: ReadonlySet<string>, accountId: string): void {
  const normalized = canonicalAccountId(providerId, accountId);
  if (![...allowed].some((value) => canonicalAccountId(providerId, value) === normalized)) {
    throw new AdportError(
      'POLICY_VIOLATION',
      `Account ${accountId} is not active for this Adport Cloud workspace. Enable it in Accounts before using it.`,
      { provider: providerId, accountId },
    );
  }
}

/**
 * Provider-specific read tools keep their concrete provider type, so this
 * registry guard validates every explicit account argument before the tool's
 * handler can reach that provider. Broad core reads are additionally filtered
 * by AccountScopedProvider below.
 */
export function createAccountScopeAuthorizer(accountIds: Partial<Record<CloudProvider, Set<string>>>) {
  return (tool: AnyToolDefinition, input: Record<string, unknown>): void => {
    if (tool.namespace === 'core' || tool.namespace === 'mock') {
      const requested = Array.isArray(input.account_ids) ? input.account_ids.filter((value): value is string => typeof value === 'string') : [];
      for (const accountId of requested) {
        const allowedSomewhere = Object.entries(accountIds).some(([provider, allowed]) =>
          [...(allowed ?? [])].some((value) => canonicalAccountId(provider, value) === canonicalAccountId(provider, accountId)),
        );
        if (!allowedSomewhere) assertAllowed('cloud', new Set(), accountId);
      }
      return;
    }
    const allowed = accountIds[tool.namespace as CloudProvider] ?? new Set<string>();
    const explicit = typeof input.account_id === 'string'
      ? input.account_id
      : typeof input.customer_id === 'string'
        ? input.customer_id
        : undefined;
    if (explicit) assertAllowed(tool.namespace, allowed, explicit);
  };
}

/** Restricts a real provider to the tenant's persisted active-account set. */
export class AccountScopedProvider implements AdProvider {
  readonly id: string;

  constructor(private readonly provider: AdProvider, private readonly allowed: ReadonlySet<string>) {
    this.id = provider.id;
  }

  capabilities() { return this.provider.capabilities(); }

  async listAccounts() {
    return (await this.provider.listAccounts()).filter((account) => this.allowed.has(account.id));
  }

  async report(query: NormalizedQuery) {
    const accountIds = query.accountIds ?? [...this.allowed];
    for (const accountId of accountIds) assertAllowed(this.id, this.allowed, accountId);
    if (accountIds.length === 0) return { rows: [], truncated: false };
    return this.provider.report({ ...query, accountIds });
  }

  async previewWrite(operation: WriteOperation, guard: WriteGuard) {
    assertAllowed(this.id, this.allowed, operation.accountId);
    return this.provider.previewWrite(operation, guard);
  }

  async applyWrite(operation: WriteOperation, guard: WriteGuard) {
    assertAllowed(this.id, this.allowed, operation.accountId);
    return this.provider.applyWrite(operation, guard);
  }

  standardActions() { return this.provider.standardActions?.() ?? {}; }
}
