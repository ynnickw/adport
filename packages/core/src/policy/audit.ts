import { promises as fs } from 'node:fs';
import path from 'node:path';
import { adportHome } from '../paths.js';

export interface AuditEntry {
  ts: string;
  /** 'note' records external/manual changes made outside adport's write path. */
  event: 'validated' | 'applied' | 'rejected' | 'note';
  provider: string;
  tool: string;
  accountId: string;
  pendingId?: string;
  summary: string;
  details?: unknown;
}

/** Append-only JSONL, one file per month: ${ADPORT_HOME}/audit/audit-YYYY-MM.jsonl */
export class AuditLog {
  constructor(private readonly dir: string = path.join(adportHome(), 'audit')) {}

  private file(now = new Date()): string {
    const month = now.toISOString().slice(0, 7);
    return path.join(this.dir, `audit-${month}.jsonl`);
  }

  async append(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const full: AuditEntry = { ts: new Date().toISOString(), ...entry };
    await fs.appendFile(this.file(), `${JSON.stringify(full)}\n`, { mode: 0o600 });
  }

  /** Most recent entries, newest last. Reads across all monthly files. */
  async read(limit = 50): Promise<AuditEntry[]> {
    let names: string[];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.jsonl')).sort();
    } catch {
      return [];
    }
    const entries: AuditEntry[] = [];
    for (const name of names) {
      const raw = await fs.readFile(path.join(this.dir, name), 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim()) entries.push(JSON.parse(line) as AuditEntry);
      }
    }
    return entries.slice(-limit);
  }
}
