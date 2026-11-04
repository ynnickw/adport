// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetLibrary } from '@/app/dashboard/assets/asset-library';
import { AssetDistribution } from '@/app/dashboard/assets/asset-distribution';

const mocks = vi.hoisted(() => ({ upload: vi.fn(), change: vi.fn(), action: vi.fn() }));
vi.mock('@/app/dashboard/assets/media-client', async original => ({ ...await original<typeof import('@/app/dashboard/assets/media-client')>(), uploadProjectFile: mocks.upload, applyLibraryChange: mocks.change, mediaAction: mocks.action }));
const id = '11111111-1111-4111-8111-111111111111', sha256 = 'a'.repeat(64), projectId = '22222222-2222-4222-8222-222222222222';
const asset = { id, name: 'Launch.png', content_type: 'image/png', byte_length: 1024, sha256, status: 'READY' as const, metadata_version: 3, platforms: [] as [], tags: ['launch'] };
const props = { projectId, projectName: 'QA', initialAssets: [asset], truncated: false, canUpload: true, acceptedTypes: ['image/png'], maxBytes: 50 * 1024 * 1024, storageOrigin: 'https://qa.supabase.co' };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ assets: [asset], truncated: false })));
  HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); }; HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); };
  mocks.change.mockResolvedValue({ status: 'applied' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('central creative library interactions', () => {
  it('accepts a multi-file drop, runs at most two uploads at once and retains each file outcome', async () => {
    const finish: Array<() => void> = [];
    mocks.upload.mockImplementation(input => new Promise(resolve => { input.progress('Uploading', 25, id); finish.push(() => resolve(id)); }));
    render(<AssetLibrary {...props} />);
    const files = ['first.png', 'second.png', 'third.png'].map(name => new File(['data'], name, { type: 'image/png' }));
    fireEvent.drop(screen.getByRole('region', { name: 'Upload creative files' }), { dataTransfer: { types: ['Files'], files } });
    expect(mocks.upload).toHaveBeenCalledTimes(2); expect(screen.getByText('third.png')).toBeTruthy(); expect(screen.getByText('Queued')).toBeTruthy();
    await act(async () => { finish[0]!(); }); await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(3));
    await act(async () => { finish[1]!(); finish[2]!(); });
    await waitFor(() => expect(screen.getAllByText('Ready')).toHaveLength(3));
    expect(mocks.upload.mock.calls.map(([input]) => input.projectId)).toEqual([projectId, projectId, projectId]);
  });
  it('binds a drag-to-channel label to this project, immutable source and metadata version', async () => {
    render(<AssetLibrary {...props} />);
    const target = screen.getByRole('button', { name: 'Meta Ads' });
    fireEvent.drop(target, { dataTransfer: { types: ['application/x-adport-media'], getData: () => JSON.stringify({ projectId: 'another-project', ids: [id] }) } });
    expect(mocks.change).not.toHaveBeenCalled();
    fireEvent.drop(target, { dataTransfer: { types: ['application/x-adport-media'], getData: () => JSON.stringify({ projectId, ids: [id] }) } });
    await waitFor(() => expect(mocks.change).toHaveBeenCalledWith(projectId, 'media_update_metadata', { media_id: id, expected_sha256: sha256, expected_version: 3, platforms: ['meta'] }));
    expect(screen.getByText(/No channel upload was requested/)).toBeTruthy();
  });
  it('preserves read-only browsing while hiding upload and editing actions', () => {
    render(<AssetLibrary {...props} canUpload={false} />);
    expect(screen.queryByRole('button', { name: 'Upload files' })).toBeNull(); expect(screen.getByRole('button', { name: 'Preview Launch.png' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Launch.png' }));
    expect(screen.queryByRole('button', { name: 'Organize' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Distribute' })).toBeNull();
  });
});

describe('central distribution approvals', () => {
  const destination = { provider: 'meta', account_id: 'account', account_name: 'QA account', available: true, stage: 'upload', tool: 'meta_upload_image', arguments: { account_id: 'account', media_id: id, expected_sha256: sha256 }, ready: true, fields: [] };
  it('does not retry an unknown upload or reuse its consumed UI approval', async () => {
    mocks.action.mockImplementation(async (_project, tool, args) => {
      if (tool === 'media_distribution_plan') return { destinations: [destination], errors: [] };
      if (args.pending_operation_id) throw new Error('Unknown outcome. Check distribution history.');
      return { status: 'pending_validation', pending_operation_id: 'one-use', preview: { summary: 'Upload Launch.png', changes: ['Unattached image only'] } };
    });
    render(<AssetDistribution projectId={projectId} assets={[asset]} libraryAssets={[asset]} onChange={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy()); fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare previews' })); await screen.findByText('Upload Launch.png');
    fireEvent.click(screen.getByRole('button', { name: 'Approve 1 operation' }));
    await screen.findByText('Unknown outcome. Check distribution history.'); expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(mocks.action.mock.calls.filter(([, tool, args]) => tool === 'meta_upload_image' && args.pending_operation_id)).toHaveLength(1);
  });
});
