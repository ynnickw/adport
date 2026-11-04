import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpProjectLogoUrls } from '@/lib/cloud/mcp-project-logos';

const mocks = vi.hoisted(() => ({ signed: vi.fn(), bucket: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ storage: { from: mocks.bucket } }) }));
const id = 'ccd3710c-594a-4c31-8cc0-3f0317213154';
const file = '0350a0a1-567d-427e-a479-c3a385cd3da6.png';
const path = `project/${id}/${file}`;
beforeEach(() => { vi.clearAllMocks(); mocks.bucket.mockReturnValue({ createSignedUrls: mocks.signed }); });

describe('authorized project logo previews', () => {
  it('signs only each authorized project own logo for fifteen minutes', async () => {
    const url = 'https://example.supabase.co/storage/v1/object/sign/workspace-logos/'+path+'?token=temporary';
    mocks.signed.mockResolvedValue({ data: [{ path, signedUrl: url, error: null }], error: null });
    const logos = await mcpProjectLogoUrls([
      { id, logoPath: path }, { id, logoPath: `project/another-project/${file}` },
      { id, logoPath: `organization/${id}/${file}` }, { id, logoPath: `project/${id}/../private.png` },
      { id, logoPath: null },
    ]);
    expect(mocks.bucket).toHaveBeenCalledWith('workspace-logos');
    expect(mocks.signed).toHaveBeenCalledExactlyOnceWith([path], 900);
    expect([...logos]).toEqual([[path, url]]);
  });
  it('keeps the project directory usable when logos are missing or signing fails', async () => {
    expect(await mcpProjectLogoUrls([{ id, logoPath: null }])).toEqual(new Map());
    expect(mocks.signed).not.toHaveBeenCalled();
    mocks.signed.mockRejectedValue(new Error('Storage unavailable'));
    expect(await mcpProjectLogoUrls([{ id, logoPath: path }])).toEqual(new Map());
    mocks.signed.mockResolvedValue({ data: [{ path: 'unexpected', signedUrl: 'https://example.test/other' }, { path, error: 'Not found' }], error: null });
    expect(await mcpProjectLogoUrls([{ id, logoPath: path }])).toEqual(new Map());
  });
});
