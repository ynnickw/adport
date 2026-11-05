import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { AdportError, adportHome } from '@adport/core';
import { z } from 'zod';

export const catalogScope = z.object({ accountId: z.string().regex(/^\d{1,30}$/), businessId: z.string().regex(/^\d{1,30}$/), resourceId: z.string().regex(/^\d{1,30}$/), kind: z.enum(['catalog', 'catalog_creation']) }).strict();
export type TikTokCatalogScope = z.infer<typeof catalogScope>;
export const catalogAccessMode = z.enum(['none', 'read', 'write', 'create']);
export type TikTokCatalogAccessMode = z.infer<typeof catalogAccessMode>;
export interface TikTokCatalogGrant { scope: TikTokCatalogScope; mode: TikTokCatalogAccessMode; revision: number; hash: string }
export interface TikTokCatalogAccessStore {
  readonly canManage: boolean;
  readonly canWrite: boolean;
  get(scope: TikTokCatalogScope): Promise<TikTokCatalogGrant>;
  /** Recheck active account/principal scope before native resource access. */
  authorize(scope: TikTokCatalogScope, write: boolean): Promise<TikTokCatalogGrant>;
  list(accountId: string): Promise<TikTokCatalogGrant[]>;
  /** Only the local owner or authenticated dashboard owner/admin may change access. */
  compareAndSet(scope: TikTokCatalogScope, expectedHash: string, mode: TikTokCatalogAccessMode): Promise<TikTokCatalogGrant>;
}
export function catalogGrant(scope: TikTokCatalogScope, mode: TikTokCatalogAccessMode = 'none', revision = 0): TikTokCatalogGrant {
  const parsed = catalogScope.parse(scope);catalogAccessMode.parse(mode);
  if (!Number.isSafeInteger(revision) || revision < 0 || parsed.kind === 'catalog_creation' && (parsed.resourceId !== parsed.businessId || !['none', 'create'].includes(mode)) || parsed.kind === 'catalog' && mode === 'create') throw new AdportError('INVALID_INPUT', 'Invalid TikTok catalog access configuration.');
  return { scope: parsed, mode, revision, hash: createHash('sha256').update(JSON.stringify([parsed.accountId, parsed.businessId, parsed.kind, parsed.resourceId, mode, revision])).digest('hex') };
}
export function catalogScopeKey(scope: TikTokCatalogScope) { return catalogGrant(scope).hash; }
export async function requireCatalogAccess(store: TikTokCatalogAccessStore | undefined, scope: TikTokCatalogScope, write = false) {
  if (!store) throw new AdportError('POLICY_VIOLATION', 'Catalog access has not been selected for this project. An owner or admin must grant the exact Business Center/catalog in Accounts.');
  if (write && !store.canWrite) throw new AdportError('POLICY_VIOLATION', 'This connection cannot modify TikTok catalogs.');
  const grant = await store.authorize(scope, write);
  if (catalogScopeKey(grant.scope) !== catalogScopeKey(scope)) throw new AdportError('POLICY_VIOLATION', 'Catalog grant scope does not match the requested resource.');
  if (!(write ? grant.mode === 'write' : grant.mode === 'read' || grant.mode === 'write')) throw new AdportError('POLICY_VIOLATION', `This project does not have ${write ? 'write' : 'read'} access to the selected TikTok catalog. Ask an owner or admin to review catalog access in Accounts.`);
  return grant;
}

/** Local-owner scope, separate from OAuth secrets. No default Business Center wildcard. */
export class FileTikTokCatalogAccessStore implements TikTokCatalogAccessStore {
  readonly canManage = true;
  readonly canWrite = true;
  constructor(private readonly dir = path.join(adportHome(), 'catalog-access', 'tiktok')) {}
  private file(scope: TikTokCatalogScope) { return path.join(this.dir, catalogScopeKey(scope) + '.json'); }
  async authorize(scope: TikTokCatalogScope, _write: boolean) { return this.get(scope); }
  async get(scope: TikTokCatalogScope): Promise<TikTokCatalogGrant> {
    const absent = catalogGrant(scope);let handle;
    try {
      handle = await fs.open(this.file(scope), constants.O_RDONLY | constants.O_NOFOLLOW);await handle.chmod(0o600);
      if ((await handle.stat()).size > 65536) throw new Error('size');
      const value = JSON.parse(await handle.readFile('utf8')) as { scope: TikTokCatalogScope; mode: TikTokCatalogAccessMode; revision: number };
      const grant = catalogGrant(value.scope, value.mode, value.revision);
      if (catalogScopeKey(grant.scope) !== catalogScopeKey(scope)) throw new Error('scope');
      return grant;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absent;
      throw new AdportError('POLICY_VIOLATION', 'Local TikTok catalog access could not be verified.');
    } finally { await handle?.close(); }
  }
  async list(accountId: string): Promise<TikTokCatalogGrant[]> {
    if (!/^\d{1,30}$/.test(accountId)) throw new AdportError('INVALID_INPUT', 'Invalid advertiser ID.');
    let files: string[];
    try { files = await fs.readdir(this.dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];throw error; }
    const names = files.filter(value => /^[a-f0-9]{64}\.json$/.test(value));
    if (names.length > 5000) throw new AdportError('POLICY_VIOLATION', 'Local catalog access inventory exceeds its verification bound.');
    const rows: TikTokCatalogGrant[] = [];
    for (const name of names) {
      let handle;
      try {
        handle = await fs.open(path.join(this.dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        await handle.chmod(0o600);
        if ((await handle.stat()).size > 65536) throw new Error('size');
        const value = JSON.parse(await handle.readFile('utf8')) as { scope: TikTokCatalogScope; mode: TikTokCatalogAccessMode; revision: number };
        const grant = catalogGrant(value.scope, value.mode, value.revision);
        if (catalogScopeKey(grant.scope) + '.json' !== name) throw new Error('scope');
        if (grant.scope.accountId === accountId && grant.mode !== 'none') rows.push(grant);
      } catch { throw new AdportError('POLICY_VIOLATION', 'Local TikTok catalog access inventory could not be verified.'); }
      finally { await handle?.close(); }
    }
    return rows;
  }
  async compareAndSet(scope: TikTokCatalogScope, expectedHash: string, mode: TikTokCatalogAccessMode) {
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
