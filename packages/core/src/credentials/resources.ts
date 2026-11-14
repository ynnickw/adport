import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { adportHome } from '../paths.js';

/** Provider credentials for one native resource, separate from its OAuth grant. */
export interface ResourceSecretScope {
  provider: string;
  accountId: string;
  businessId: string;
  resourceId: string;
  credentialId: string;
}
export interface ResourceSecretStore {
  has(scope: ResourceSecretScope): Promise<boolean>;
  get(scope: ResourceSecretScope): Promise<string | undefined>;
  putIfAbsent(scope: ResourceSecretScope, secret: string): Promise<boolean>;
  delete(scope: ResourceSecretScope): Promise<boolean>;
}

export function resourceSecretKey(scope: ResourceSecretScope): string {
  const values = [scope.provider, scope.accountId, scope.businessId, scope.resourceId, scope.credentialId];
  if (values.some(value => typeof value !== 'string' || !value.length || value.length > 256 || /[\x00-\x1f\x7f]/.test(value))) throw new Error('Invalid resource credential scope.');
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

/** Local secrets use private files, atomic publication and exclusive creation. */
export class FileResourceSecretStore implements ResourceSecretStore {
  constructor(private readonly dir = path.join(adportHome(), 'resource-credentials')) {}
  private file(scope: ResourceSecretScope) { return path.join(this.dir, resourceSecretKey(scope) + '.json'); }
  async get(scope: ResourceSecretScope): Promise<string | undefined> {
    let handle;
    try {
      handle = await fs.open(this.file(scope), constants.O_RDONLY | constants.O_NOFOLLOW);
      await handle.chmod(0o600);
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('scope' in value) || !('secret' in value) || typeof value.secret !== 'string' || !value.secret.length || resourceSecretKey(value.scope as ResourceSecretScope) !== resourceSecretKey(scope)) throw new Error('Invalid stored resource credential.');
      return value.secret;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      // JSON parse diagnostics can include a fragment of the secret-bearing file.
      throw new Error('Private resource credential could not be read.');
    }
    finally { await handle?.close(); }
  }
  async has(scope: ResourceSecretScope) { return (await this.get(scope)) !== undefined; }
  async putIfAbsent(scope: ResourceSecretScope, secret: string): Promise<boolean> {
    const destination = this.file(scope);
    if (typeof secret !== 'string' || !secret.length || secret.length > 65536) throw new Error('Invalid resource credential.');
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });await fs.chmod(this.dir, 0o700);
    const temporary = path.join(this.dir, randomUUID() + '.tmp');
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ version: 1, scope, secret }) + '\n');await handle.sync(); }
      finally { await handle.close(); }
      // link is atomic and refuses an existing destination; rename would overwrite it.
      try { await fs.link(temporary, destination);return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;throw error; }
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async delete(scope: ResourceSecretScope): Promise<boolean> {
    try { await fs.unlink(this.file(scope));return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;throw error; }
  }
}
