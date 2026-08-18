import { promises as fs } from 'node:fs';
import path from 'node:path';
import { adportHome } from '../paths.js';
import type { AuditFinding, FindingStatus } from './types.js';

export interface FindingsRepository {
  list(filter?: { status?: FindingStatus; provider?: string }): Promise<AuditFinding[]>;
  get(id: string): Promise<AuditFinding | undefined>;
  save(finding: AuditFinding): Promise<void>;
  setStatus(id: string, status: FindingStatus): Promise<AuditFinding>;
}

/**
 * Findings persist on disk with their approval lifecycle — the durable side of
 * the recommendation harness: a recommendation can wait for a human decision
 * across restarts, indefinitely, at zero cost.
 */
export class FindingsStore implements FindingsRepository {
  constructor(private readonly dir: string = path.join(adportHome(), 'findings')) {}

  private file(id: string): string {
    return path.join(this.dir, `${id.replace(/[^a-zA-Z0-9_.:-]/g, '_')}.json`);
  }

  async list(filter: { status?: FindingStatus; provider?: string } = {}): Promise<AuditFinding[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const findings: AuditFinding[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const finding = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')) as AuditFinding;
      if (filter.status && finding.status !== filter.status) continue;
      if (filter.provider && finding.provider !== filter.provider) continue;
      findings.push(finding);
    }
    const order: Record<string, number> = { critical: 0, warn: 1, info: 2 };
    return findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  }

  async get(id: string): Promise<AuditFinding | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as AuditFinding;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async save(finding: AuditFinding): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file(finding.id), JSON.stringify(finding, null, 2), { mode: 0o600 });
  }

  async setStatus(id: string, status: FindingStatus): Promise<AuditFinding> {
    const finding = await this.get(id);
    if (!finding) throw new Error(`Finding not found: ${id}`);
    const updated = { ...finding, status, updatedAt: new Date().toISOString() };
    await this.save(updated);
    return updated;
  }
}
