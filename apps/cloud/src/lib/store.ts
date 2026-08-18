import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  AuditEntry,
  AuditFinding,
  AuditRepository,
  CredentialRecord,
  CredentialRepository,
  CredentialSource,
  FindingsRepository,
  FindingStatus,
  PendingOperation,
  PendingRepository,
  Policy,
} from '@adport/core';
import { DEFAULT_POLICY } from '@adport/core';
import { decryptJson, encryptJson } from './crypto';

export interface CloudIdentity {
  userId: string;
  email: string;
  name: string;
}

export interface CloudTenant extends CloudIdentity {
  workspaceId: string;
  workspaceName: string;
  role: 'owner' | 'admin' | 'analyst' | 'approver';
}

export interface CloudConnection {
  provider: string;
  source: CredentialSource | 'demo';
  status: 'connected' | 'error';
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  accountCount: number;
}

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be text`);
  return value;
}

function optionalText(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' ? value : undefined;
}

export class CloudStore {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS provider_connections (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        encrypted_credentials TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT,
        PRIMARY KEY (workspace_id, provider)
      );
      CREATE TABLE IF NOT EXISTS account_allowlist (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_name TEXT NOT NULL,
        currency TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, provider, account_id)
      );
      CREATE TABLE IF NOT EXISTS pending_operations (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS findings (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        provider TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );
      CREATE INDEX IF NOT EXISTS audit_events_workspace_ts ON audit_events(workspace_id, ts);
      CREATE INDEX IF NOT EXISTS findings_workspace_status ON findings(workspace_id, status);
    `);
  }

  bootstrap(identity: CloudIdentity): CloudTenant {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, updated_at=excluded.updated_at
    `).run(identity.userId, identity.email, identity.name, now, now);

    let membership = this.db.prepare(`
      SELECT m.workspace_id, m.role, w.name AS workspace_name
      FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ? ORDER BY m.created_at LIMIT 1
    `).get(identity.userId) as Row | undefined;

    if (!membership) {
      const workspaceId = randomUUID();
      const workspaceName = `${identity.name}'s workspace`;
      this.db.prepare('INSERT INTO workspaces (id, name, policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(workspaceId, workspaceName, JSON.stringify(DEFAULT_POLICY), now, now);
      this.db.prepare('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
        .run(workspaceId, identity.userId, 'owner', now);
      membership = { workspace_id: workspaceId, workspace_name: workspaceName, role: 'owner' };
    }

    return {
      ...identity,
      workspaceId: text(membership, 'workspace_id'),
      workspaceName: text(membership, 'workspace_name'),
      role: text(membership, 'role') as CloudTenant['role'],
    };
  }

  listConnections(workspaceId: string): CloudConnection[] {
    const rows = this.db.prepare(`
      SELECT c.provider, c.source, c.status, c.created_at, c.updated_at, c.last_checked_at,
             COUNT(a.account_id) AS account_count
      FROM provider_connections c
      LEFT JOIN account_allowlist a ON a.workspace_id=c.workspace_id AND a.provider=c.provider
      WHERE c.workspace_id=? GROUP BY c.provider ORDER BY c.provider
    `).all(workspaceId) as Row[];
    return rows.map((row) => ({
      provider: text(row, 'provider'),
      source: text(row, 'source') as CloudConnection['source'],
      status: text(row, 'status') as CloudConnection['status'],
      createdAt: text(row, 'created_at'),
      updatedAt: text(row, 'updated_at'),
      lastCheckedAt: optionalText(row, 'last_checked_at'),
      accountCount: Number(row.account_count ?? 0),
    }));
  }

  saveCredential(workspaceId: string, record: Omit<CredentialRecord, 'createdAt' | 'updatedAt'>): CredentialRecord {
    const existing = this.credential(workspaceId, record.provider);
    const now = new Date().toISOString();
    const full: CredentialRecord = { ...record, createdAt: existing?.createdAt ?? now, updatedAt: now };
    const encrypted = encryptJson(full.data, workspaceId);
    this.db.prepare(`
      INSERT INTO provider_connections (workspace_id, provider, source, status, encrypted_credentials, created_at, updated_at, last_checked_at)
      VALUES (?, ?, ?, 'connected', ?, ?, ?, ?)
      ON CONFLICT(workspace_id, provider) DO UPDATE SET source=excluded.source, status='connected',
        encrypted_credentials=excluded.encrypted_credentials, updated_at=excluded.updated_at, last_checked_at=excluded.last_checked_at
    `).run(workspaceId, record.provider, record.source, encrypted, full.createdAt, now, now);
    return full;
  }

  connectDemo(workspaceId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO provider_connections (workspace_id, provider, source, status, created_at, updated_at, last_checked_at)
      VALUES (?, 'mock', 'demo', 'connected', ?, ?, ?)
      ON CONFLICT(workspace_id, provider) DO UPDATE SET status='connected', updated_at=excluded.updated_at, last_checked_at=excluded.last_checked_at
    `).run(workspaceId, now, now, now);
  }

  credential(workspaceId: string, provider: string): CredentialRecord | undefined {
    const row = this.db.prepare(`
      SELECT provider, source, encrypted_credentials, created_at, updated_at
      FROM provider_connections WHERE workspace_id=? AND provider=? AND encrypted_credentials IS NOT NULL
    `).get(workspaceId, provider) as Row | undefined;
    if (!row) return undefined;
    return {
      provider: text(row, 'provider'),
      source: text(row, 'source') as CredentialSource,
      data: decryptJson<Record<string, string>>(text(row, 'encrypted_credentials'), workspaceId),
      createdAt: text(row, 'created_at'),
      updatedAt: text(row, 'updated_at'),
    };
  }

  listCredentials(workspaceId: string): CredentialRecord[] {
    const providers = this.db.prepare('SELECT provider FROM provider_connections WHERE workspace_id=? AND encrypted_credentials IS NOT NULL')
      .all(workspaceId) as Row[];
    return providers.map((row) => this.credential(workspaceId, text(row, 'provider'))).filter((value): value is CredentialRecord => Boolean(value));
  }

  deleteConnection(workspaceId: string, provider: string): boolean {
    this.db.prepare('DELETE FROM account_allowlist WHERE workspace_id=? AND provider=?').run(workspaceId, provider);
    const result = this.db.prepare('DELETE FROM provider_connections WHERE workspace_id=? AND provider=?').run(workspaceId, provider);
    return result.changes > 0;
  }

  saveAccounts(workspaceId: string, accounts: Array<{ provider: string; id: string; name: string; currency?: string; status?: string }>): void {
    const now = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO account_allowlist (workspace_id, provider, account_id, account_name, currency, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, provider, account_id) DO UPDATE SET account_name=excluded.account_name,
        currency=excluded.currency, status=excluded.status
    `);
    for (const account of accounts) {
      statement.run(workspaceId, account.provider, account.id, account.name, account.currency ?? null, account.status ?? null, now);
    }
  }

  listAccounts(workspaceId: string): Array<{ provider: string; id: string; name: string; currency?: string; status?: string }> {
    const rows = this.db.prepare(`
      SELECT provider, account_id, account_name, currency, status
      FROM account_allowlist WHERE workspace_id=? ORDER BY provider, account_name
    `).all(workspaceId) as Row[];
    return rows.map((row) => ({
      provider: text(row, 'provider'), id: text(row, 'account_id'), name: text(row, 'account_name'),
      currency: optionalText(row, 'currency'), status: optionalText(row, 'status'),
    }));
  }

  policy(workspaceId: string): Policy {
    const row = this.db.prepare('SELECT policy_json FROM workspaces WHERE id=?').get(workspaceId) as Row | undefined;
    return row ? JSON.parse(text(row, 'policy_json')) as Policy : DEFAULT_POLICY;
  }

  credentials(workspaceId: string): CredentialRepository {
    return new WorkspaceCredentialRepository(this, workspaceId);
  }

  pending(workspaceId: string): PendingRepository & { list(): Promise<PendingOperation[]> } {
    return new WorkspacePendingRepository(this, workspaceId);
  }

  audit(workspaceId: string): AuditRepository {
    return new WorkspaceAuditRepository(this, workspaceId);
  }

  findings(workspaceId: string): FindingsRepository {
    return new WorkspaceFindingsRepository(this, workspaceId);
  }
}

class WorkspaceCredentialRepository implements CredentialRepository {
  constructor(private store: CloudStore, private workspaceId: string) {}
  async get(provider: string) { return this.store.credential(this.workspaceId, provider); }
  async list() { return this.store.listCredentials(this.workspaceId); }
  async set(record: Omit<CredentialRecord, 'createdAt' | 'updatedAt'>) { return this.store.saveCredential(this.workspaceId, record); }
  async delete(provider: string) { return this.store.deleteConnection(this.workspaceId, provider); }
}

class WorkspacePendingRepository implements PendingRepository {
  constructor(private store: CloudStore, private workspaceId: string) {}
  async put(op: PendingOperation) {
    this.store.db.prepare(`INSERT OR REPLACE INTO pending_operations (workspace_id, id, payload_json, expires_at) VALUES (?, ?, ?, ?)`)
      .run(this.workspaceId, op.id, JSON.stringify(op), op.expiresAt);
  }
  async get(id: string) {
    const row = this.store.db.prepare('SELECT payload_json FROM pending_operations WHERE workspace_id=? AND id=?')
      .get(this.workspaceId, id) as Row | undefined;
    return row ? JSON.parse(text(row, 'payload_json')) as PendingOperation : undefined;
  }
  async delete(id: string) {
    this.store.db.prepare('DELETE FROM pending_operations WHERE workspace_id=? AND id=?').run(this.workspaceId, id);
  }
  async sweep(now = new Date()) {
    this.store.db.prepare('DELETE FROM pending_operations WHERE workspace_id=? AND expires_at < ?').run(this.workspaceId, now.toISOString());
  }
  async list() {
    const rows = this.store.db.prepare('SELECT payload_json FROM pending_operations WHERE workspace_id=? ORDER BY expires_at')
      .all(this.workspaceId) as Row[];
    return rows.map((row) => JSON.parse(text(row, 'payload_json')) as PendingOperation);
  }
}

class WorkspaceAuditRepository implements AuditRepository {
  constructor(private store: CloudStore, private workspaceId: string) {}
  async append(entry: Omit<AuditEntry, 'ts'>) {
    const full: AuditEntry = { ts: new Date().toISOString(), ...entry };
    this.store.db.prepare('INSERT INTO audit_events (id, workspace_id, payload_json, ts) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), this.workspaceId, JSON.stringify(full), full.ts);
  }
  async read(limit = 50) {
    const rows = this.store.db.prepare('SELECT payload_json FROM audit_events WHERE workspace_id=? ORDER BY ts DESC LIMIT ?')
      .all(this.workspaceId, limit) as Row[];
    return rows.map((row) => JSON.parse(text(row, 'payload_json')) as AuditEntry).reverse();
  }
}

class WorkspaceFindingsRepository implements FindingsRepository {
  constructor(private store: CloudStore, private workspaceId: string) {}
  async list(filter: { status?: FindingStatus; provider?: string } = {}) {
    const clauses = ['workspace_id=?'];
    const values: SQLInputValue[] = [this.workspaceId];
    if (filter.status) { clauses.push('status=?'); values.push(filter.status); }
    if (filter.provider) { clauses.push('provider=?'); values.push(filter.provider); }
    const rows = this.store.db.prepare(`SELECT payload_json FROM findings WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`)
      .all(...values) as Row[];
    return rows.map((row) => JSON.parse(text(row, 'payload_json')) as AuditFinding);
  }
  async get(id: string) {
    const row = this.store.db.prepare('SELECT payload_json FROM findings WHERE workspace_id=? AND id=?')
      .get(this.workspaceId, id) as Row | undefined;
    return row ? JSON.parse(text(row, 'payload_json')) as AuditFinding : undefined;
  }
  async save(finding: AuditFinding) {
    this.store.db.prepare(`
      INSERT INTO findings (workspace_id, id, status, provider, payload_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, id) DO UPDATE SET status=excluded.status, provider=excluded.provider,
        payload_json=excluded.payload_json, updated_at=excluded.updated_at
    `).run(this.workspaceId, finding.id, finding.status, finding.provider, JSON.stringify(finding), finding.updatedAt);
  }
  async setStatus(id: string, status: FindingStatus) {
    const finding = await this.get(id);
    if (!finding) throw new Error(`Finding not found: ${id}`);
    const updated = { ...finding, status, updatedAt: new Date().toISOString() };
    await this.save(updated);
    return updated;
  }
}

declare global {
  var __adportCloudStore: CloudStore | undefined;
}

export function getCloudStore(): CloudStore {
  if (!globalThis.__adportCloudStore) {
    const configured = process.env.ADPORT_CLOUD_DB;
    const filename = configured
      ? (path.isAbsolute(configured) ? configured : path.resolve(/* turbopackIgnore: true */ configured))
      : path.join(process.cwd(), '.data', 'adport-cloud.db');
    globalThis.__adportCloudStore = new CloudStore(filename);
  }
  return globalThis.__adportCloudStore;
}
