import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { AdportError, adportHome } from '@adport/core';
import { z } from 'zod';
import { redditId } from './schemas.js';
export const redditBusinessId = z.string().regex(/^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/).toLowerCase();
export const redditCatalogId = redditId.min(1).max(256);
const accountId = redditCatalogId;

export const catalogScope = z.object({ accountId, businessId: redditBusinessId, resourceId: redditCatalogId, kind: z.enum(['catalog', 'catalog_creation']) }).strict();
export type RedditCatalogScope = z.infer<typeof catalogScope>;
export const catalogAccessMode = z.enum(['none', 'read', 'write', 'create']);
export type RedditCatalogAccessMode = z.infer<typeof catalogAccessMode>;
export interface RedditCatalogGrant { scope: RedditCatalogScope; mode: RedditCatalogAccessMode; revision: number; hash: string }
export interface RedditCatalogAccessStore {
  readonly canManage: boolean;
  readonly canWrite: boolean;
  get(scope: RedditCatalogScope): Promise<RedditCatalogGrant>;
  /** Recheck active account/principal scope before native resource access. */
  authorize(scope: RedditCatalogScope, write: boolean): Promise<RedditCatalogGrant>;
  list(accountId: string): Promise<RedditCatalogGrant[]>;
  /** Only the local owner or authenticated dashboard owner/admin may change access. */
  compareAndSet(scope: RedditCatalogScope, expectedHash: string, mode: RedditCatalogAccessMode): Promise<RedditCatalogGrant>;
  /** Internal creation receipt: adopt only a freshly created, independently verified native catalog. */
  adoptCreated?(scope: RedditCatalogScope, expectedCreationHash: string): Promise<RedditCatalogGrant>;
}
export function catalogGrant(scope: RedditCatalogScope, mode: RedditCatalogAccessMode = 'none', revision = 0): RedditCatalogGrant {
  const parsed = catalogScope.parse(scope);catalogAccessMode.parse(mode);
  if (!Number.isSafeInteger(revision) || revision < 0 || parsed.kind === 'catalog_creation' && (parsed.resourceId !== parsed.businessId || !['none', 'create'].includes(mode)) || parsed.kind === 'catalog' && mode === 'create') throw new AdportError('INVALID_INPUT', 'Invalid Reddit catalog access configuration.');
  return { scope: parsed, mode, revision, hash: createHash('sha256').update(JSON.stringify(['reddit', parsed.accountId, parsed.businessId, parsed.kind, parsed.resourceId, mode, revision])).digest('hex') };
}
export function catalogScopeKey(scope: RedditCatalogScope) { return catalogGrant(scope).hash; }
export async function requireCatalogAccess(store: RedditCatalogAccessStore | undefined, scope: RedditCatalogScope, write = false) {
  if (!store) throw new AdportError('POLICY_VIOLATION', 'Catalog access has not been selected for this project. An owner or admin must grant the exact Business/catalog in Accounts.');
  if (write && !store.canWrite) throw new AdportError('POLICY_VIOLATION', 'This connection cannot modify Reddit catalogs.');
  const grant = await store.authorize(scope, write);
  if (catalogScopeKey(grant.scope) !== catalogScopeKey(scope)) throw new AdportError('POLICY_VIOLATION', 'Catalog grant scope does not match the requested resource.');
  if (!(write ? grant.mode === 'write' : grant.mode === 'read' || grant.mode === 'write')) throw new AdportError('POLICY_VIOLATION', `This project does not have ${write ? 'write' : 'read'} access to the selected Reddit catalog. Ask an owner or admin to review catalog access in Accounts.`);
  return grant;
}

export const creationScope = (accountId: string, businessId: string): RedditCatalogScope => { const normalized = redditBusinessId.parse(businessId);return catalogScope.parse({ accountId, businessId: normalized, resourceId: normalized, kind: 'catalog_creation' }); };
export async function requireCatalogCreationAccess(store: RedditCatalogAccessStore | undefined, scope: RedditCatalogScope, write = false) {
  if (!store || scope.kind !== 'catalog_creation' || scope.resourceId !== scope.businessId || write && !store.canWrite) throw new AdportError('POLICY_VIOLATION', 'Catalog creation requires owner-delegated creation access and a writable connection.');
  const grant = await store.authorize(scope, write);
  if (catalogScopeKey(grant.scope) !== catalogScopeKey(scope) || grant.mode !== 'create') throw new AdportError('POLICY_VIOLATION', 'An owner must delegate catalog creation for this exact advertiser and Business. Existing catalog grants do not grant creation access.');
  return grant;
}

/** Local-owner scope, separate from OAuth secrets. No default Business wildcard. */
export class FileRedditCatalogAccessStore implements RedditCatalogAccessStore {
  readonly canManage = true;
  readonly canWrite = true;
  constructor(private readonly dir = path.join(adportHome(), 'catalog-access', 'reddit')) {}
  private file(scope: RedditCatalogScope) { return path.join(this.dir, catalogScopeKey(scope) + '.json'); }
  async authorize(scope: RedditCatalogScope, _write: boolean) { return this.get(scope); }
  async get(scope: RedditCatalogScope): Promise<RedditCatalogGrant> {
    const absent = catalogGrant(scope);let handle;
    try {
      handle = await fs.open(this.file(scope), constants.O_RDONLY | constants.O_NOFOLLOW);await handle.chmod(0o600);
      if ((await handle.stat()).size > 65536) throw new Error('size');
      const value = JSON.parse(await handle.readFile('utf8')) as { scope: RedditCatalogScope; mode: RedditCatalogAccessMode; revision: number };
      const grant = catalogGrant(value.scope, value.mode, value.revision);
      if (catalogScopeKey(grant.scope) !== catalogScopeKey(scope)) throw new Error('scope');
      return grant;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absent;
      throw new AdportError('POLICY_VIOLATION', 'Local Reddit catalog access could not be verified.');
    } finally { await handle?.close(); }
  }
  async list(accountId: string): Promise<RedditCatalogGrant[]> {
    if (!redditCatalogId.safeParse(accountId).success) throw new AdportError('INVALID_INPUT', 'Invalid advertiser ID.');
    let files: string[];
    try { files = await fs.readdir(this.dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];throw error; }
    const names = files.filter(value => /^[a-f0-9]{64}\.json$/.test(value));
    if (names.length > 5000) throw new AdportError('POLICY_VIOLATION', 'Local catalog access inventory exceeds its verification bound.');
    const rows: RedditCatalogGrant[] = [];
    for (const name of names) {
      let handle;
      try {
        handle = await fs.open(path.join(this.dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        await handle.chmod(0o600);
        if ((await handle.stat()).size > 65536) throw new Error('size');
        const value = JSON.parse(await handle.readFile('utf8')) as { scope: RedditCatalogScope; mode: RedditCatalogAccessMode; revision: number };
        const grant = catalogGrant(value.scope, value.mode, value.revision);
        if (catalogScopeKey(grant.scope) + '.json' !== name) throw new Error('scope');
        if (grant.scope.accountId === accountId && grant.mode !== 'none') rows.push(grant);
      } catch { throw new AdportError('POLICY_VIOLATION', 'Local Reddit catalog access inventory could not be verified.'); }
      finally { await handle?.close(); }
    }
    return rows;
  }
  async adoptCreated(value: RedditCatalogScope, expectedCreationHash: string) {
    const scope = catalogScope.parse(value);if (scope.kind !== 'catalog') throw new AdportError('POLICY_VIOLATION', 'Only a new exact catalog can be adopted.');
    const parent = creationScope(scope.accountId, scope.businessId);await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });await fs.chmod(this.dir, 0o700);
    const lock = path.join(this.dir, catalogScopeKey(parent) + '.lock');
    try { await fs.mkdir(lock, { mode: 0o700 }); } catch { throw new AdportError('POLICY_VIOLATION', 'Catalog creation access is changing. Reconcile the known catalog before retrying.'); }
    try {
      const grant = await requireCatalogCreationAccess(this, parent, true);if (grant.hash !== expectedCreationHash) throw new AdportError('POLICY_VIOLATION', 'Creation delegation changed. The created catalog was not adopted.');
      return await this.compareAndSet(scope, catalogGrant(scope).hash, 'write');
    } finally { await fs.rmdir(lock); }
  }
  async compareAndSet(scope: RedditCatalogScope, expectedHash: string, mode: RedditCatalogAccessMode) {
    catalogGrant(scope, mode);if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new AdportError('INVALID_INPUT', 'Read the current catalog access hash first.');
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });await fs.chmod(this.dir, 0o700);
    const lock = path.join(this.dir, catalogScopeKey(scope) + '.lock');
    try { await fs.mkdir(lock, { mode: 0o700 }); } catch { throw new AdportError('POLICY_VIOLATION', 'Catalog access is being changed by another local operation. Inspect it before retrying.'); }
    const temporary = path.join(this.dir, randomUUID() + '.tmp');
    try {
      const current = await this.get(scope);
      if (current.hash !== expectedHash) throw new AdportError('POLICY_VIOLATION', 'Catalog access changed. Read and review it again.');
      const next = catalogGrant(scope, mode, current.revision + 1), handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(next) + '\n');await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.file(scope));return next;
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });await fs.rmdir(lock);
    }
  }
}
