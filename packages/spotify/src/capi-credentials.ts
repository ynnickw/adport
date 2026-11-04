import { createHash } from 'node:crypto';
import { AdportError, type ResourceSecretScope, type ResourceSecretStore, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import type { SpotifyAdsClient } from './client.js';
import { spotifyId } from './schemas.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const capiCredentialTarget = z.object({ dataset_id: spotifyId }).strict();
const snapshot = { dataset_id: spotifyId, expected_configuration_hash: hash, expected_dataset_configuration_hash: hash, expected_token_inventory_hash: hash };
export const createCapiCredential = z.object({ ...snapshot, acknowledge_credential_access: z.literal(true) }).strict();
export const storeCapiCredential = createCapiCredential.extend({ capi_auth_token_id: spotifyId });
export const revokeCapiCredential = z.object({ ...snapshot, capi_auth_token_id: spotifyId, acknowledge_ingestion_effects: z.literal(true) }).strict();
export const capiCredentialWrites = new Set(['spotify_create_capi_credential', 'spotify_store_capi_credential', 'spotify_revoke_capi_credential']);

// GET returns secret values too. These private response objects never leave this service.
const nativeToken = z.object({ capi_auth_token_id: spotifyId, created_at: z.string().nullish(), capi_auth_token: z.string().min(1).max(65536).optional() });
const tokenList = z.object({ data: z.array(nativeToken).max(1000), paging: z.unknown().optional() }).refine(v => v.paging == null && new Set(v.data.map(t => t.capi_auth_token_id)).size === v.data.length, 'Invalid native credential inventory');
const createdToken = z.object({ data: nativeToken.extend({ capi_auth_token: z.string().min(1).max(65536) }) });
type NativeToken = z.infer<typeof nativeToken>;
export interface AuthorizedCapiCredentialScope {
  account_id: string;
  business_id: string;
  dataset_id: string;
  capi_connection_id: string;
  configuration_hash: string;
  dataset_configuration_hash: string;
}
interface Plan extends Omit<WritePreview, 'serverValidated'> { execute(): Promise<WriteResult> }
const notes = ['Local preview only; Spotify has no native validation endpoint for credentials.', 'CAPI credentials grant ongoing event-ingestion access to this integration. The native endpoint provides no configurable expiry. No token value is returned to agents, widgets or audit logs.', 'No conversion events, tracking installation, ad delivery or budget changes. Native failures are never replayed automatically.'];

export class SpotifyCapiCredentials {
  constructor(private readonly client: SpotifyAdsClient, private readonly authorize: (input: { account_id: string; dataset_id: string }) => Promise<AuthorizedCapiCredentialScope>, private readonly secrets?: ResourceSecretStore) {}
  private path(scope: AuthorizedCapiCredentialScope) { return `businesses/${scope.business_id}/capi/${scope.capi_connection_id}/tokens`; }
  private key(scope: AuthorizedCapiCredentialScope, id: string): ResourceSecretScope { return { provider: 'spotify', accountId: scope.account_id, businessId: scope.business_id, resourceId: scope.capi_connection_id, credentialId: id }; }
  private metadata(tokens: NativeToken[]) { return tokens.map(t => ({ capi_auth_token_id: t.capi_auth_token_id, created_at: t.created_at ?? null })).sort((a, b) => a.capi_auth_token_id.localeCompare(b.capi_auth_token_id)); }
  private inventoryHash(scope: AuthorizedCapiCredentialScope, tokens: NativeToken[]) { return createHash('sha256').update(JSON.stringify({ ...scope, tokens: this.metadata(tokens) })).digest('hex'); }
  private async safe<T>(call: () => Promise<T>, operation: string): Promise<T> {
    try { return await call(); }
    catch (error) {
      const status = error instanceof AdportError && error.details && typeof error.details === 'object' && 'http_status' in error.details ? error.details.http_status : undefined;
      // Native errors may echo a CAPI secret that is unrelated to the OAuth token redactor.
      throw new AdportError('PROVIDER_ERROR', `spotify: CAPI credential ${operation} failed; inspect credential metadata before any new mutation. No request was replayed.`, typeof status === 'number' ? { http_status: status } : undefined);
    }
  }
  private async tokens(scope: AuthorizedCapiCredentialScope) { return (await this.safe(() => this.client.get(this.path(scope), tokenList), 'inventory read')).data; }
  private vault() { if (!this.secrets) throw new AdportError('INVALID_INPUT', 'spotify: a private resource credential store must be configured before managing CAPI credentials.');return this.secrets; }
  async list(input: { account_id: string; dataset_id: string }) {
    const scope = await this.authorize(input), tokens = await this.tokens(scope);
    return { ...scope, credential_inventory_hash: this.inventoryHash(scope, tokens), vault_configured: !!this.secrets,
      credentials: await Promise.all(this.metadata(tokens).map(async token => ({ ...token, stored_in_adport: this.secrets ? await this.safe(() => this.secrets!.has(this.key(scope, token.capi_auth_token_id)), 'storage metadata read') : null }))), notes };
  }
  private uncertain(scope: AuthorizedCapiCredentialScope, id: string | undefined, before: NativeToken[], operation: string): never {
    throw new AdportError('PROVIDER_ERROR', `spotify: CAPI credential ${operation} is unconfirmed. Do not repeat it; read spotify_capi_credentials and reconcile the selected credential.`, { business_id: scope.business_id, dataset_id: scope.dataset_id, capi_connection_id: scope.capi_connection_id, ...(id ? { capi_auth_token_id: id, resource_ids: [id] } : {}), previous_credential_ids: this.metadata(before).map(t => t.capi_auth_token_id) });
  }
  private async save(scope: AuthorizedCapiCredentialScope, token: NativeToken & { capi_auth_token: string }) {
    const store = this.vault(), key = this.key(scope, token.capi_auth_token_id);
    await store.putIfAbsent(key, token.capi_auth_token);
    if (await store.get(key) !== token.capi_auth_token) throw new Error('Stored credential does not match native credential.');
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const creating = op.tool === 'spotify_create_capi_credential', storing = op.tool === 'spotify_store_capi_credential';
    if (!capiCredentialWrites.has(op.tool)) throw new AdportError('UNKNOWN_TOOL', 'spotify: unknown CAPI credential mutation');
    const input = creating ? createCapiCredential.parse(op.payload) : storing ? storeCapiCredential.parse(op.payload) : revokeCapiCredential.parse(op.payload);
    const vault = this.vault(), scope = await this.authorize({ account_id: op.accountId, dataset_id: input.dataset_id }), before = await this.tokens(scope);
    if (scope.configuration_hash !== input.expected_configuration_hash || scope.dataset_configuration_hash !== input.expected_dataset_configuration_hash || this.inventoryHash(scope, before) !== input.expected_token_inventory_hash) throw new AdportError('PENDING_MISMATCH', 'spotify: CAPI configuration, sharing or credential inventory changed; read spotify_capi_credentials for a new preview.');
    const id = 'capi_auth_token_id' in input ? input.capi_auth_token_id : undefined;
    const selected = before.find(t => t.capi_auth_token_id === id);
    const stored = id ? await this.safe(() => vault.has(this.key(scope, id)), 'storage metadata read') : false;
    if (storing && !selected?.capi_auth_token) throw new AdportError('INVALID_INPUT', 'spotify: the selected active credential has no available native secret to store.');
    if (!creating && !selected && !stored) throw new AdportError('INVALID_INPUT', 'spotify: the selected credential is neither active in this integration nor stored in this Adport scope.');
    const title = creating ? 'Create CAPI credential' : storing ? 'Store existing CAPI credential' : selected ? 'Revoke CAPI credential' : 'Remove inactive CAPI credential copy';
    return { summary: `${title} for Spotify integration ${scope.capi_connection_id}`, changes: [creating ? '+ One native long-lived credential, saved privately in Adport.' : storing ? `+ Store only the selected active credential ${id}; do not create a native token.` : selected ? `- Revoke native credential ${id} and remove its Adport copy after confirmed native revocation.` : `- Remove only the private Adport copy of inactive credential ${id}; no native deletion request.`, 'No events are sent.'], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'spotify', accountId: scope.account_id, kind: creating || storing ? 'create' : 'remove', title, fields: [{ label: 'Dataset', after: scope.dataset_id }, { label: 'CAPI integration', after: scope.capi_connection_id }, ...(id ? [{ label: 'Credential', after: id }, { label: 'Stored in Adport', after: stored }] : []), { label: 'Active credentials', after: before.length }], notices: notes },
      execute: async () => {
        let createdId: string | undefined, nativeAcknowledged = false;
        try {
          if (creating) {
            const token = (await this.safe(() => this.client.mutate(this.path(scope), 'POST', undefined, createdToken), 'creation')).data;
            nativeAcknowledged = true;
            createdId = token.capi_auth_token_id;
            if (before.some(t => t.capi_auth_token_id === createdId)) throw new Error('Creation returned an existing credential ID.');
            await this.save(scope, token);
            const after = await this.tokens(scope);
            const actual = after.find(t => t.capi_auth_token_id === createdId);
            if (!actual || actual.capi_auth_token !== undefined && actual.capi_auth_token !== token.capi_auth_token) throw new Error('Credential readback mismatch.');
            return { applied: true, resourceIds: [createdId], details: { capi_auth_token_id: createdId, stored_in_adport: true, created_at: token.created_at ?? null, next_tool: 'spotify_capi_credentials' } };
          }
          if (storing) {
            await this.save(scope, selected as NativeToken & { capi_auth_token: string });
            return { applied: true, resourceIds: [id!], details: { capi_auth_token_id: id, stored_in_adport: true, native_credential_created: false } };
          }
          if (selected) { await this.safe(() => this.client.mutate(`${this.path(scope)}/${id}`, 'DELETE', undefined, z.undefined()), 'revocation');nativeAcknowledged = true; }
          if ((await this.tokens(scope)).some(t => t.capi_auth_token_id === id)) throw new Error('Credential remains active.');
          await vault.delete(this.key(scope, id!));
          return { applied: true, resourceIds: [id!], details: { capi_auth_token_id: id, native_active: false, stored_in_adport: false } };
        } catch (error) {
          // No raw native response, secret value, storage exception or stack is exposed.
          if (!nativeAcknowledged && error instanceof AdportError && error.details && typeof error.details === 'object' && 'http_status' in error.details && [400, 401, 403, 404, 409, 422].includes(Number(error.details.http_status))) throw error;
          return this.uncertain(scope, createdId ?? id, before, creating ? 'creation/storage' : storing ? 'storage' : 'revocation/cleanup');
        }
      } };
  }
}
