// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MediaAsset } from '@adport/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetLibrary } from '@/app/dashboard/assets/asset-library';
import { AssetPreview } from '@/app/dashboard/assets/asset-preview';

const mocks = vi.hoisted(() => ({ upload: vi.fn(), change: vi.fn(), action: vi.fn() }));
vi.mock('@/app/dashboard/assets/media-client', async original => ({ ...await original<typeof import('@/app/dashboard/assets/media-client')>(), uploadProjectFile: mocks.upload, applyLibraryChange: mocks.change, mediaAction: mocks.action }));
const sha256 = 'a'.repeat(64), projectId = '22222222-2222-4222-8222-222222222222';
function source(index: number, fields: Partial<MediaAsset> = {}): MediaAsset { return { id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, name: `File ${index}.png`, content_type: 'image/png', byte_length: 1024, sha256, status: 'READY', metadata_version: 3, platforms: ['meta'], tags: ['launch'], preview_url: `https://qa.supabase.co/source-${index}?token=old`, ...fields }; }
const asset = source(1, { name: 'Launch.png' });
const props = { projectId, projectName: 'QA', connectedPlatforms: ['meta', 'apple'] as const, initialAssets: [asset], truncated: false, canUpload: true, acceptedTypes: ['image/png'], maxBytes: 50 * 1024 * 1024, storageOrigin: 'https://qa.supabase.co' };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ assets: [asset], truncated: false })));
  HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); }; HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('simple agent-first creative library', () => {
  it('keeps only compact browsing/upload controls and moves tags into the three-dot popover', () => {
    render(<AssetLibrary {...props} />);
    expect(screen.getByRole('combobox', { name: 'File type' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upload files' })).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByText('Channel labels')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Organize' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Distribute' })).toBeNull();
    expect(screen.queryByText('Select shown')).toBeNull(); expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Launch.png' }));
    expect(screen.getByRole('dialog', { name: 'Tags for Launch.png' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Tags' })).toHaveProperty('value', 'launch');
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });

  it('saves only the selected file tags and keeps all existing previews mounted without a list request', async () => {
    const video = source(2, { name: 'Clip.mp4', content_type: 'video/mp4' });
    mocks.change.mockResolvedValue({ status: 'applied', result: { details: { asset: { ...asset, preview_url: undefined, tags: ['summer', 'testimonial'], metadata_version: 4 } } } });
    const view = render(<AssetLibrary {...props} initialAssets={[asset, video]} />);
    await waitFor(() => expect(view.container.querySelector('video')).not.toBeNull());
    const player = view.container.querySelector('video'), image = screen.getByAltText('Launch.png');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Launch.png' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Tags' }), { target: { value: 'Summer, testimonial' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tags' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.change).toHaveBeenCalledExactlyOnceWith(projectId, 'media_update_metadata', { media_id: asset.id, expected_sha256: sha256, expected_version: 3, tags: ['summer', 'testimonial'] });
    expect(screen.getByRole('button', { name: 'summer' })).toBeTruthy(); expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByAltText('Launch.png')).toBe(image); expect(view.container.querySelector('video')).toBe(player);
    expect(player?.getAttribute('src')).toBe(`${video.preview_url}#t=0.1`);
  });

  it('offers only connected platform tags and preserves other existing labels when saving without reloading media', async () => {
    const labeled = { ...asset, platforms: ['meta', 'google'] as MediaAsset['platforms'] }, video = source(2, { content_type: 'video/mp4' });
    mocks.change.mockResolvedValue({ status: 'applied', result: { details: { asset: { ...labeled, platforms: ['apple', 'google', 'meta'], metadata_version: 4 } } } });
    const view = render(<AssetLibrary {...props} initialAssets={[labeled, video]} />);
    await waitFor(() => expect(view.container.querySelector('video')).not.toBeNull()); const player = view.container.querySelector('video');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Launch.png' }));
    expect(screen.getByRole('button', { name: 'Meta Ads', pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apple Ads', pressed: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Google Ads' })).toBeNull(); expect(screen.queryByRole('button', { name: 'TikTok Ads' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Apple Ads' }));
    expect(mocks.change).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save tags' })); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.change).toHaveBeenCalledExactlyOnceWith(projectId, 'media_update_metadata', { media_id: asset.id, expected_sha256: sha256, expected_version: 3, tags: ['launch'], platforms: ['meta', 'google', 'apple'] });
    expect(view.container.querySelector('video')).toBe(player); expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Launch.png' })); expect(screen.getByRole('button', { name: 'Apple Ads', pressed: true })).toBeTruthy();
  });

  it('keeps custom tags available without suggesting platforms when none are connected', () => {
    render(<AssetLibrary {...props} connectedPlatforms={[]} />); fireEvent.click(screen.getByRole('button', { name: 'Actions for Launch.png' }));
    expect(screen.queryByRole('group', { name: 'Platforms' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Meta Ads' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Tags' })).toHaveProperty('value', 'launch');
  });

  it('opens and closes a preview immediately without fetching details or resetting gallery media', async () => {
    const video = source(2, { name: 'Clip.mp4', content_type: 'video/mp4' });
    const view = render(<AssetLibrary {...props} initialAssets={[video]} />);
    await waitFor(() => expect(view.container.querySelector('video')).not.toBeNull()); const thumbnail = view.container.querySelector('video');
    fireEvent.click(screen.getByRole('button', { name: 'Preview Clip.mp4' }));
    expect(screen.getByRole('dialog', { name: 'Clip.mp4' })).toBeTruthy(); expect(mocks.action).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText('Channel uploads')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' })); expect(view.container.querySelector('video')).toBe(thumbnail);
  });

  it('appends pages for over 100 files, locks duplicate load-more clicks, and preserves loaded pages when filters are revisited', async () => {
    const all = Array.from({ length: 103 }, (_, index) => source(index + 1));
    let finish: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(Response.json({ assets: all.slice(96), truncated: false })).mockResolvedValueOnce(Response.json({ assets: [], truncated: false }));
    render(<AssetLibrary {...props} initialAssets={all.slice(0, 48)} truncated initialCursor={all[47]!.id} />);
    const firstImage = screen.getByAltText('File 1.png');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' })); fireEvent.click(screen.getByRole('button', { name: 'Loading…' }));
    expect(fetch).toHaveBeenCalledTimes(1); expect(screen.getAllByRole('article')).toHaveLength(48);
    await act(async () => { finish!(Response.json({ assets: all.slice(48, 96), truncated: true, next_cursor: all[95]!.id })); });
    await screen.findByText('96 shown'); expect(screen.getByAltText('File 1.png')).toBe(firstImage);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' })); await screen.findByText('103 files');
    expect(screen.getAllByRole('article')).toHaveLength(103); expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const calls = vi.mocked(fetch).mock.calls; expect(new URL(String(calls[0]![0]), 'https://app.test').searchParams.get('cursor')).toBe(all[47]!.id); expect(new URL(String(calls[1]![0]), 'https://app.test').searchParams.get('limit')).toBe('48');
    fireEvent.change(screen.getByRole('combobox', { name: 'File type' }), { target: { value: 'video' } }); await screen.findByText('No matching files');
    fireEvent.change(screen.getByRole('combobox', { name: 'File type' }), { target: { value: '' } }); await screen.findByText('103 files');
    expect(fetch).toHaveBeenCalledTimes(3); expect(screen.getAllByRole('article')).toHaveLength(103);
  });

  it('ignores late filter responses while keeping the existing grid visible during requests', async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
    render(<AssetLibrary {...props} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'File type' }), { target: { value: 'video' } }); await waitFor(() => expect(pending).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Preview Launch.png' })).toBeTruthy(); expect(screen.getByRole('button', { name: 'Refresh library' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'File type' }), { target: { value: 'audio' } }); await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => { pending[1]!(Response.json({ assets: [source(3, { name: 'Audio.mp3', content_type: 'audio/mpeg' })], truncated: false })); });
    await screen.findByRole('button', { name: 'Preview Audio.mp3' });
    await act(async () => { pending[0]!(Response.json({ assets: [source(4, { name: 'Late.mp4', content_type: 'video/mp4' })], truncated: false })); });
    expect(screen.queryByRole('button', { name: 'Preview Late.mp4' })).toBeNull(); expect(screen.getByRole('button', { name: 'Preview Audio.mp3' })).toBeTruthy();
  });

  it('refreshes the already loaded page range without replacing existing video nodes or sources', async () => {
    const all = Array.from({ length: 49 }, (_, index) => source(index + 1, { content_type: 'video/mp4' }));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ assets: [all[48]], truncated: false })).mockResolvedValueOnce(Response.json({ assets: all.slice(0, 48).map(asset => ({ ...asset, preview_url: 'https://qa.supabase.co/renewed' })), truncated: true, next_cursor: all[47]!.id })).mockResolvedValueOnce(Response.json({ assets: [all[48]], truncated: false }));
    const view = render(<AssetLibrary {...props} initialAssets={all.slice(0, 48)} truncated initialCursor={all[47]!.id} />);
    await waitFor(() => expect(view.container.querySelector('video')).not.toBeNull()); const player = view.container.querySelector('video'), original = player?.getAttribute('src');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' })); await screen.findByText('49 files');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh library' })); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh library' }).hasAttribute('disabled')).toBe(false));
    expect(screen.getAllByRole('article')).toHaveLength(49); expect(view.container.querySelector('video')).toBe(player); expect(player?.getAttribute('src')).toBe(original);
  });

  it('uploads a dropped batch with two workers and inserts confirmed files without reloading the list', async () => {
    const finish: Array<() => void> = [];
    mocks.upload.mockImplementation(input => new Promise(resolve => { const index = finish.length + 5; input.progress('Uploading', 25, asset.id); finish.push(() => { const ready = source(index, { name: input.file.name }); input.ready(ready); resolve(ready.id); }); }));
    render(<AssetLibrary {...props} />); const firstImage = screen.getByAltText('Launch.png');
    const selected = ['first.png', 'second.png', 'third.png'].map(name => new File(['data'], name, { type: 'image/png' }));
    fireEvent.drop(screen.getByRole('region', { name: 'Creative files' }), { dataTransfer: { types: ['Files'], files: selected } });
    expect(mocks.upload).toHaveBeenCalledTimes(2); expect(screen.getByText('Queued')).toBeTruthy();
    await act(async () => { finish[0]!(); }); await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(3));
    await act(async () => { finish[1]!(); finish[2]!(); }); await waitFor(() => expect(screen.getAllByText('Ready')).toHaveLength(3));
    expect(fetch).not.toHaveBeenCalled(); expect(screen.getByAltText('Launch.png')).toBe(firstImage); expect(screen.getAllByRole('article')).toHaveLength(4);
  });

  it('does not replay an unconfirmed tag change; an explicit per-file reload is needed', async () => {
    mocks.change.mockRejectedValue(new Error('Unknown outcome')); mocks.action.mockResolvedValue({ asset: { ...asset, metadata_version: 4 } });
    render(<AssetLibrary {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Actions for Launch.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save tags' })); await screen.findByRole('button', { name: 'Reload file' });
    expect(mocks.change).toHaveBeenCalledTimes(1); expect(screen.queryByRole('button', { name: 'Save tags' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload file' })); await screen.findByRole('button', { name: 'Save tags' });
    expect(mocks.action).toHaveBeenCalledExactlyOnceWith(projectId, 'media_get', { media_id: asset.id }); expect(mocks.change).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });

  it('hydrates only a newly uploaded file when the finalization receipt omits preview URLs', async () => {
    const uploaded = source(8, { name: 'New.mp4', content_type: 'video/mp4', preview_url: undefined });
    const hydrated = { ...uploaded, preview_url: 'https://qa.supabase.co/new-video' };
    mocks.action.mockResolvedValue({ asset: hydrated });
    mocks.upload.mockImplementation(async input => { input.ready(uploaded); return uploaded.id; });
    render(<AssetLibrary {...props} />); const original = screen.getByAltText('Launch.png');
    fireEvent.drop(screen.getByRole('region', { name: 'Creative files' }), { dataTransfer: { types: ['Files'], files: [new File(['data'], 'New.mp4', { type: 'video/mp4' })] } });
    await waitFor(() => expect(document.querySelector('video')?.src).toBe(hydrated.preview_url + '#t=0.1'));
    expect(mocks.action).toHaveBeenCalledExactlyOnceWith(projectId, 'media_get', { media_id: uploaded.id });
    expect(fetch).not.toHaveBeenCalled(); expect(screen.getByAltText('Launch.png')).toBe(original);
  });

  it('preserves read-only browsing without upload, labeling, selection or mutation controls', () => {
    render(<AssetLibrary {...props} canUpload={false} />);
    expect(screen.queryByRole('button', { name: 'Upload files' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Actions for Launch.png' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.getByRole('button', { name: 'Preview Launch.png' })).toBeTruthy();
  });
});

describe('stable media source', () => {
  it('adopts a renewed signed URL only after the current source fails', async () => {
    const original = source(1, { content_type: 'video/mp4' }), view = render(<AssetPreview asset={original} projectId={projectId} expanded />);
    const player = view.container.querySelector('video')!;
    view.rerender(<AssetPreview asset={{ ...original, preview_url: 'https://qa.supabase.co/fresh' }} projectId={projectId} expanded />);
    expect(view.container.querySelector('video')).toBe(player); expect(player.src).toBe(original.preview_url);
    fireEvent.error(player); await waitFor(() => expect(view.container.querySelector('video')?.src).toBe('https://qa.supabase.co/fresh'));
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it('recovers an expired preview once without reloading the library', async () => {
    const original = source(1, { content_type: 'video/mp4' }), fresh = { ...original, preview_url: 'https://qa.supabase.co/renewed' }, onRefresh = vi.fn();
    let finish!: (result: { asset: MediaAsset }) => void;
    mocks.action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<AssetPreview asset={original} projectId={projectId} expanded onRefresh={onRefresh} />);
    fireEvent.error(view.container.querySelector('video')!);
    expect(screen.getByText('Refreshing preview…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Loading…' })).toHaveProperty('disabled', true);
    await act(async () => { finish({ asset: fresh }); });
    expect(view.container.querySelector('video')?.src).toBe(fresh.preview_url);
    expect(mocks.action).toHaveBeenCalledExactlyOnceWith(projectId, 'media_get', { media_id: original.id });
    expect(onRefresh).toHaveBeenCalledExactlyOnceWith(fresh); expect(fetch).not.toHaveBeenCalled();
    fireEvent.error(view.container.querySelector('video')!);
    expect(screen.getByRole('button', { name: 'Retry preview' })).toBeTruthy(); expect(mocks.action).toHaveBeenCalledTimes(1);
    mocks.action.mockResolvedValueOnce({ asset: { ...fresh, preview_url: 'https://qa.supabase.co/manual' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
    await waitFor(() => expect(view.container.querySelector('video')?.src).toBe('https://qa.supabase.co/manual'));
    expect(mocks.action).toHaveBeenCalledTimes(2);
  });

  it('leaves a manual retry after a failed automatic refresh without looping', async () => {
    const original = source(1, { content_type: 'audio/mp3' });
    mocks.action.mockRejectedValueOnce(new Error('Temporarily unavailable'));
    const view = render(<AssetPreview asset={original} projectId={projectId} expanded />);
    fireEvent.error(view.container.querySelector('audio')!);
    await screen.findByText('Preview unavailable');
    view.rerender(<AssetPreview asset={{ ...original, tags: ['changed'] }} projectId={projectId} expanded />);
    expect(mocks.action).toHaveBeenCalledTimes(1); expect(screen.getByRole('button', { name: 'Retry preview' })).toBeTruthy();
  });

  it.each(['asset', 'project', 'checksum'] as const)('discards a delayed refresh after the %s changes', async field => {
    const original = source(1, { content_type: 'video/mp4' }), onRefresh = vi.fn();
    let finish!: (result: { asset: MediaAsset }) => void;
    mocks.action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<AssetPreview asset={original} projectId={projectId} expanded onRefresh={onRefresh} />);
    fireEvent.error(view.container.querySelector('video')!);
    const next = field === 'asset' ? source(2, { content_type: 'video/mp4' }) : field === 'checksum' ? { ...original, sha256: 'b'.repeat(64), preview_url: 'https://qa.supabase.co/replaced' } : original;
    view.rerender(<AssetPreview asset={next} projectId={field === 'project' ? 'other-project' : projectId} expanded onRefresh={onRefresh} />);
    const player = view.container.querySelector('video');
    await act(async () => { finish({ asset: { ...original, preview_url: 'https://qa.supabase.co/old-request' } }); });
    expect(view.container.querySelector('video')).toBe(player); expect(player?.src).toBe(next.preview_url); expect(onRefresh).not.toHaveBeenCalled();
  });

  it('keeps a newer parent recovery when an earlier refresh completes', async () => {
    const original = source(1, { content_type: 'video/mp4' }), onRefresh = vi.fn();
    let finish!: (result: { asset: MediaAsset }) => void;
    mocks.action.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<AssetPreview asset={original} projectId={projectId} expanded onRefresh={onRefresh} />);
    fireEvent.error(view.container.querySelector('video')!);
    view.rerender(<AssetPreview asset={{ ...original, preview_url: 'https://qa.supabase.co/newer' }} projectId={projectId} expanded onRefresh={onRefresh} />);
    await waitFor(() => expect(view.container.querySelector('video')?.src).toBe('https://qa.supabase.co/newer'));
    const player = view.container.querySelector('video');
    await act(async () => { finish({ asset: { ...original, preview_url: 'https://qa.supabase.co/older' } }); });
    expect(view.container.querySelector('video')).toBe(player); expect(player?.src).toBe('https://qa.supabase.co/newer'); expect(onRefresh).not.toHaveBeenCalled();
  });

  it('rejects a refresh for different bytes', async () => {
    const original = source(1, { content_type: 'video/mp4' }), onRefresh = vi.fn();
    mocks.action.mockResolvedValueOnce({ asset: { ...original, sha256: 'b'.repeat(64), preview_url: 'https://qa.supabase.co/wrong' } });
    const view = render(<AssetPreview asset={original} projectId={projectId} expanded onRefresh={onRefresh} />);
    fireEvent.error(view.container.querySelector('video')!);
    await screen.findByText('Preview unavailable'); expect(onRefresh).not.toHaveBeenCalled(); expect(view.container.querySelector('video')).toBeNull();
  });
});
