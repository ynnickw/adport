import 'server-only';
import { AdportError, createContext, PolicyEngine, SyntheticProvider, syntheticTools, syntheticStateSchema, type SyntheticStateStore } from '@adport/core';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { getOrganizationPolicy, PostgresAuditStore, PostgresFindingsStore, PostgresPendingStore } from './repository';
import type { TenantPrincipal } from './types';

/** Never use user metadata, an HTTP parameter, or organization settings to enable this. */
export function isSyntheticReviewer(organizationId: string): boolean {
  return (env().ADPORT_SYNTHETIC_REVIEWER_ORGANIZATION_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean).includes(organizationId);
}

class PostgresSyntheticStore implements SyntheticStateStore {
  constructor(private readonly organizationId: string) {}
  async load() {
    const rows = await db()`select campaigns from private.synthetic_reviewer_workspaces where organization_id = ${this.organizationId}`;
    if (!rows[0]) throw new AdportError('NOT_CONNECTED', 'Synthetic reviewer workspace has not been provisioned.');
    return syntheticStateSchema.parse(rows[0].campaigns);
  }
  async save(expected: Parameters<SyntheticStateStore['save']>[0], next: Parameters<SyntheticStateStore['save']>[1]) {
    const sql = db();
    const rows = await sql`update private.synthetic_reviewer_workspaces set campaigns = ${sql.json(syntheticStateSchema.parse(next))}
      where organization_id = ${this.organizationId} and campaigns = ${sql.json(expected)} returning organization_id`;
    if (!rows.length) throw new AdportError('PENDING_MISMATCH', 'Synthetic state changed concurrently. Request a new preview.');
  }
}

export async function createSyntheticReviewerRuntime(principal: TenantPrincipal) {
  if (!isSyntheticReviewer(principal.organizationId)) throw new AdportError('POLICY_VIOLATION', 'Synthetic reviewer access is not enabled.');
  const store = new PostgresSyntheticStore(principal.organizationId);
  await store.load(); // Fail closed before registering tools; never fall back to real credentials.
  const provider = new SyntheticProvider(store);
  const policy = { ...await getOrganizationPolicy(principal.organizationId), require_validation: true, paused_creation: true };
  const runtime = await createContext({
    providerModules: [{ provider, tools: syntheticTools(provider) }],
    engine: new PolicyEngine(policy, new PostgresPendingStore(principal), new PostgresAuditStore(principal)),
    findings: new PostgresFindingsStore(principal.organizationId),
    authorizeToolCall(_tool, input) {
      for (const id of [input.account_id, input.customer_id, ...(Array.isArray(input.account_ids) ? input.account_ids : [])]) {
        if (typeof id === 'string') provider.assertAccount(id);
      }
    },
  });
  runtime.dataSource = 'synthetic';
  return runtime;
}
