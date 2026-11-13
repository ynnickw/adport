import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { adportHome } from '../paths.js';
import type { WriteOperation, WritePreview } from '../provider.js';

export interface PendingOperation {
  id: string;
  provider: string;
  opHash: string;
  op: WriteOperation;
  preview: WritePreview;
  createdAt: string;
  expiresAt: string;
}

/** Persistence contract used by the policy engine in local and hosted runtimes. */
export interface PendingOperationStore {
  put(op: PendingOperation): Promise<void>;
  get(id: string): Promise<PendingOperation | undefined>;
  /** Atomically consume one matching, unexpired approval before provider execution. */
  consume(id: string, expectedHash: string): Promise<boolean>;
  delete(id: string): Promise<void>;
  sweep(now?: Date): Promise<void>;
}

/**
 * File-backed store so validate and apply can happen in different processes
 * (CLI invocations, MCP server restarts).
 */
export class PendingStore implements PendingOperationStore {
  constructor(private readonly dir: string = path.join(adportHome(), 'pending')) {}

  private file(id: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error(`Invalid pending operation id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  async put(op: PendingOperation): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file(op.id), JSON.stringify(op, null, 2), { mode: 0o600 });
  }

  async get(id: string): Promise<PendingOperation | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as PendingOperation;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
  }

  async consume(id: string, expectedHash: string): Promise<boolean> {
    const current = await this.get(id);
    if (!current || current.opHash !== expectedHash || !(Date.parse(current.expiresAt) > Date.now())) return false;
    const source = this.file(id), claimed = `${source}.${randomUUID()}.claim`;
    try { await fs.rename(source, claimed); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    // Rename removes the shared source atomically across processes. Never put
    // it back, including after a crash, bad receipt, timeout or failed audit.
    try {
      const actual = JSON.parse(await fs.readFile(claimed, 'utf8')) as PendingOperation;
      return actual.opHash === expectedHash && Date.parse(actual.expiresAt) > Date.now();
    } finally { await fs.rm(claimed, { force: true }); }
  }

  /** Remove expired entries. Called opportunistically; never throws on races. */
  async sweep(now = new Date()): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json') && !name.endsWith('.claim')) continue;
      try {
        const op = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')) as PendingOperation;
        if (Date.parse(op.expiresAt) < now.getTime()) {
          await fs.rm(path.join(this.dir, name), { force: true });
        }
      } catch {
        // Unreadable entry: leave it; get() will surface the problem explicitly.
      }
    }
  }
}
