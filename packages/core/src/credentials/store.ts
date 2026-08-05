import { promises as fs } from 'node:fs';
import path from 'node:path';
import { adportHome } from '../paths.js';

export type CredentialSource = 'byo' | 'broker';

export interface CredentialRecord {
  provider: string;
  source: CredentialSource;
  /** Provider-specific key/value secrets (tokens, client ids, ...). */
  data: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface CredentialFile {
  version: 1;
  credentials: Record<string, CredentialRecord>;
}

const EMPTY: CredentialFile = { version: 1, credentials: {} };

/**
 * File-backed credential store: ${ADPORT_HOME}/credentials.json, chmod 600.
 * OS keychain support may come later; the interface is deliberately async.
 */
export class CredentialStore {
  constructor(private readonly dir: string = adportHome()) {}

  private file(): string {
    return path.join(this.dir, 'credentials.json');
  }

  private async read(): Promise<CredentialFile> {
    try {
      const raw = await fs.readFile(this.file(), 'utf8');
      return JSON.parse(raw) as CredentialFile;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
      throw err;
    }
  }

  private async write(data: CredentialFile): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file(), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(this.file(), 0o600);
  }

  async get(provider: string): Promise<CredentialRecord | undefined> {
    const file = await this.read();
    return file.credentials[provider];
  }

  async list(): Promise<CredentialRecord[]> {
    const file = await this.read();
    return Object.values(file.credentials);
  }

  async set(record: Omit<CredentialRecord, 'createdAt' | 'updatedAt'>): Promise<CredentialRecord> {
    const file = await this.read();
    const now = new Date().toISOString();
    const existing = file.credentials[record.provider];
    const full: CredentialRecord = { ...record, createdAt: existing?.createdAt ?? now, updatedAt: now };
    file.credentials[record.provider] = full;
    await this.write(file);
    return full;
  }

  async delete(provider: string): Promise<boolean> {
    const file = await this.read();
    if (!(provider in file.credentials)) return false;
    delete file.credentials[provider];
    await this.write(file);
    return true;
  }
}
