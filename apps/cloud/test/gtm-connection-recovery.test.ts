import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rejectUnavailableGtm } from '@/lib/cloud/gtm-connection-recovery';
import { resetEnvForTests } from '@/lib/env';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: () => query }));
beforeEach(() => { vi.stubEnv('ADPORT_CLOUD_BASE_URL', 'https://app.adport.dev'); resetEnvForTests(); query.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); resetEnvForTests(); });

describe('GTM connection recovery before provider execution', () => {
  it('explains pending account selection without reading secrets or consuming approval', async () => {
    query.mockResolvedValue([{ status: 'connected', selectionPending: true, projectName: 'QA project' }]);
    await expect(rejectUnavailableGtm({ organizationId: 'qa-project', scopes: [] }, true)).rejects.toMatchObject({
      code: 'NOT_CONNECTED', message: expect.stringContaining('waiting for account selection in QA project'),
      details: { apply_state: 'NOT_STARTED', connection_recovery: { kind: 'account_selection', project_id: 'qa-project', dashboard_url: 'https://app.adport.dev/dashboard/analytics' } },
    });
    const [parts, project] = query.mock.calls[0]!;
    expect(parts.join('')).toMatch(/^\s*select /); expect(project).toBe('qa-project');
    expect(parts.join('')).not.toMatch(/ciphertext|insert|update|delete/i);
  });
  it('handles selection completing after runtime assembly as a changed connection', async () => {
    query.mockResolvedValue([{ status: 'connected', selectionPending: false, projectName: 'QA project' }]);
    await expect(rejectUnavailableGtm({ organizationId: 'qa-project', scopes: [] }, true)).rejects.toMatchObject({
      details: { apply_state: 'NOT_STARTED', connection_recovery: { kind: 'connection_changed' } },
    });
  });
  it('does not imply a read was an attempted write and directs a revoked grant to reconnect', async () => {
    query.mockResolvedValue([{ status: 'revoked', selectionPending: false }]);
    try { await rejectUnavailableGtm({ organizationId: 'qa-project', scopes: [] }, false); }
    catch (error) { expect(error).toMatchObject({ details: { connection_recovery: { kind: 'reconnect' } } }); expect((error as { details: object }).details).not.toHaveProperty('apply_state'); }
  });
});
