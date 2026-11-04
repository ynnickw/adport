import 'server-only';
import { AdportError, resourceSecretKey, type ResourceSecretScope, type ResourceSecretStore } from '@adport/core';
import { db } from '@/lib/db';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import type { TenantPrincipal } from './types';

/** Project/account scoping and authenticated encryption protect each native secret. */
export class PostgresResourceSecretStore implements ResourceSecretStore {
  constructor(private readonly principal: TenantPrincipal, private readonly provider: string, private readonly enabledAccounts: ReadonlySet<string>) {}
  private key(scope: ResourceSecretScope, write = false) {
    if (scope.provider !== this.provider || !this.enabledAccounts.has(scope.accountId)) throw new AdportError('POLICY_VIOLATION', 'Resource credential is outside the selected project account scope.');
    if (write ? !this.principal.scopes.includes('tools:write') || this.principal.role === 'viewer' : !this.principal.scopes.some(scope => ['tools:read', 'tools:write'].includes(scope))) throw new AdportError('POLICY_VIOLATION', 'Resource credential access is not permitted by this grant.');
    return resourceSecretKey(scope);
  }
  private aad(key: string) { return `resource-credential:v1:${this.principal.organizationId}:${key}`; }
  async has(scope: ResourceSecretScope) {
    const key = this.key(scope);
    const rows = await db()<Array<{ present: boolean }>>`select exists(select 1 from private.provider_resource_credentials where organization_id = ${this.principal.organizationId} and resource_key = ${key}) as present`;
    return rows[0]?.present === true;
  }
  async get(scope: ResourceSecretScope) {
    const key = this.key(scope, true);
    const rows = await db()<Array<{ ciphertext: string }>>`select ciphertext from private.provider_resource_credentials where organization_id = ${this.principal.organizationId} and resource_key = ${key}`;
    if (!rows[0]) return undefined;
    const value = decryptSecret<{ secret: string }>(rows[0].ciphertext, this.aad(key));
    if (typeof value.secret !== 'string' || !value.secret.length) throw new Error('Invalid stored resource credential.');
    return value.secret;
  }
  async putIfAbsent(scope: ResourceSecretScope, secret: string) {
    const key = this.key(scope, true);
    if (typeof secret !== 'string' || !secret.length || secret.length > 65536) throw new Error('Invalid resource credential.');
    const rows = await db()<Array<{ resourceKey: string }>>`insert into private.provider_resource_credentials (organization_id, resource_key, provider, account_id, business_id, resource_id, credential_id, ciphertext)
      values (${this.principal.organizationId}, ${key}, ${scope.provider}, ${scope.accountId}, ${scope.businessId}, ${scope.resourceId}, ${scope.credentialId}, ${encryptSecret({ secret }, this.aad(key))})
      on conflict (organization_id, resource_key) do nothing returning resource_key`;
    return rows.length === 1;
  }
  async delete(scope: ResourceSecretScope) {
    const key = this.key(scope, true);
    const rows = await db()<Array<{ resourceKey: string }>>`delete from private.provider_resource_credentials where organization_id = ${this.principal.organizationId} and resource_key = ${key} returning resource_key`;
    return rows.length === 1;
  }
}
