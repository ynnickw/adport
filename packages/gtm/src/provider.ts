import { createHash } from 'node:crypto';
import { AdportError, gtmWriteSchemas, type AdProvider, type Account, type NormalizedQuery, type Report,
  type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { GtmClient, type GtmResource } from './client.js';

function numeric(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new AdportError('INVALID_INPUT', 'GTM IDs must be numeric strings.');
  return value;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function assertFingerprint(resource: GtmResource, expected: unknown) {
  if (!expected || resource.fingerprint !== expected) throw new AdportError('PENDING_MISMATCH', 'GTM configuration changed. Read the resource and preview again.');
}

export class GtmProvider implements AdProvider {
  readonly id = 'gtm';
  constructor(private readonly client: GtmClient) {}
  capabilities() { return { serverDryRun: false, reporting: false }; }
  async listAccounts(): Promise<Account[]> {
    const accounts: Account[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    do {
      const response = await this.client.request('accounts', 'GET', undefined, pageToken ? { pageToken } : {});
      for (const account of (response.account ?? []) as GtmResource[]) accounts.push({ provider: this.id, id: numeric(account.accountId), name: String(account.name ?? account.accountId) });
      pageToken = response.nextPageToken as string | undefined;
      if (pageToken && seen.has(pageToken)) throw new AdportError('PROVIDER_ERROR', 'GTM repeated an account pagination token.');
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    return accounts;
  }
  async report(_query: NormalizedQuery): Promise<Report> {
    throw new AdportError('INVALID_INPUT', 'GTM exposes tracking configuration. Use Google Ads or GA4 for performance metrics.');
  }
  read(accountId: string, suffix: string, query?: Record<string, string>): Promise<GtmResource> {
    return this.client.request(`accounts/${numeric(accountId)}${suffix}`, 'GET', undefined, query);
  }
  async workspaceStatus(accountId: string, containerId: string, workspaceId: string) {
    const base = `/containers/${numeric(containerId)}/workspaces/${numeric(workspaceId)}`;
    const workspace = await this.read(accountId, base);
    const status = await this.read(accountId, `${base}/status`);
    const workspace_hash = createHash('sha256').update(JSON.stringify(stable({ workspace, status }))).digest('hex');
    return { workspace, status, workspace_hash };
  }
  private async plan(op: WriteOperation) {
    if (op.provider !== this.id || !(op.tool in gtmWriteSchemas)) throw new AdportError('INVALID_INPUT', 'Unsupported GTM operation.');
    const parsed = gtmWriteSchemas[op.tool as keyof typeof gtmWriteSchemas].safeParse(op.payload);
    if (!parsed.success) throw new AdportError('INVALID_INPUT', 'Invalid GTM configuration.', parsed.error.issues);
    const p = parsed.data as Record<string, unknown>;
    const account = numeric(op.accountId);
    const container = `accounts/${account}/containers/${numeric(p.container_id)}`;
    let path = `${container}/workspaces`;
    let method = 'POST';
    let body: unknown;
    const query: Record<string, string> = {};
    const changes: string[] = [];
    if (op.tool === 'gtm_create_workspace') {
      await this.client.request(container);
      body = { name: p.name, ...(p.description === undefined ? {} : { description: p.description }) };
    } else if (op.tool === 'gtm_publish_version') {
      path = `${container}/versions/${numeric(p.version_id)}`;
      const version = await this.client.request(path);
      assertFingerprint(version, p.expected_fingerprint);
      let liveId = '0';
      try { liveId = String((await this.client.request(`${container}/versions:live`)).containerVersionId); }
      catch (error) { if (!(error instanceof AdportError && error.details && (error.details as { status?: number }).status === 404)) throw error; }
      if (liveId !== p.expected_live_version_id) throw new AdportError('PENDING_MISMATCH', 'The live GTM version changed. Review the published configuration and preview again.');
      path += ':publish'; query.fingerprint = String(p.expected_fingerprint);
      changes.push(`Publish complete version ${p.version_id}, replacing live version ${liveId}.`, JSON.stringify(version));
    } else {
      path += `/${numeric(p.workspace_id)}`;
      if (op.tool === 'gtm_create_version') {
        const snapshot = await this.workspaceStatus(account, numeric(p.container_id), numeric(p.workspace_id));
        if (snapshot.workspace_hash !== p.expected_workspace_hash) throw new AdportError('PENDING_MISMATCH', 'Workspace changes differ from the reviewed snapshot. Read gtm_workspace_status and preview again.');
        if (Array.isArray(snapshot.status.mergeConflict) && snapshot.status.mergeConflict.length) throw new AdportError('POLICY_VIOLATION', 'Resolve GTM workspace conflicts before creating a version.');
        path += ':create_version'; body = { name: p.name, ...(p.notes === undefined ? {} : { notes: p.notes }) };
        changes.push('Save ALL workspace changes; Google replaces the workspace. This does not publish.', JSON.stringify(snapshot.status));
      } else {
        const entity = op.tool.split('_').at(-1)!;
        path += `/${entity === 'variable' ? 'variables' : `${entity}s`}`;
        body = p[entity];
        if (op.tool.startsWith('gtm_update_')) {
          path += `/${numeric(p[`${entity}_id`])}`; method = 'PUT';
          const current = await this.client.request(path);
          assertFingerprint(current, p.expected_fingerprint);
          query.fingerprint = String(p.expected_fingerprint);
          // Preserve fields outside the supported editable schema, including sequencing and consent.
          body = { ...current, ...(body as GtmResource) };
          changes.push(`Before: ${JSON.stringify(current)}`);
        } else await this.client.request(`${container}/workspaces/${numeric(p.workspace_id)}`);
      }
    }
    if (body) changes.push(`After: ${JSON.stringify(body)}`);
    const preview: WritePreview = { summary: `${op.tool.replaceAll('_', ' ')} in GTM account ${account}`, changes,
      coercions: [], budgetDeltas: [], serverValidated: false };
    return { path, method, body, query, preview };
  }
  async previewWrite(op: WriteOperation): Promise<WritePreview> { return (await this.plan(op)).preview; }
  async applyWrite(op: WriteOperation): Promise<WriteResult> {
    const plan = await this.plan(op);
    const result = await this.client.request(plan.path, plan.method, plan.body, plan.query);
    if (result.compilerError || (result.syncStatus as GtmResource | undefined)?.mergeConflict || (result.syncStatus as GtmResource | undefined)?.syncError) {
      throw new AdportError('PROVIDER_ERROR', 'GTM returned compiler or synchronization errors. Inspect the workspace/version before retrying.');
    }
    const resource = (result.containerVersion ?? result) as GtmResource;
    return { applied: true, resourceIds: [String(resource.path ?? plan.path)], details: result };
  }
}
