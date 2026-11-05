import { describe, expect, it, vi } from 'vitest';
import { createContext, selectRuntimeCatalog } from '../src/context.js';
import { MockProvider } from '../src/testing/mock-provider.js';
import { classifyTool } from '../src/tools/catalog.js';
import { MEDIA_PREPARATION_TOOLS, MEDIA_UPLOAD_TOOLS } from '../src/tools/media-distribution.js';
import { guardedWriteTool } from '../src/tools/write.js';
import { z } from 'zod';

describe('catalog runtime boundaries', () => {
  it('restricts shared account reads and reports to the selected providers', async () => {
    const original = new MockProvider();
    const excluded = new MockProvider();
    Object.defineProperty(excluded, 'id', { value: 'other' });
    const read = vi.spyOn(excluded, 'listAccounts');
    const report = vi.spyOn(excluded, 'report');
    const runtime = await createContext({ providerModules: [{ provider: original, tools: [] }, { provider: excluded, tools: [] }] });
    const selected = selectRuntimeCatalog(runtime, { profile: 'reporting', providers: [] });
    await expect(selected.registry.call('accounts_list', {}, selected.ctx)).rejects.toThrow(/No ad providers are connected/);
    await expect(selected.registry.call('report', { provider: 'other' }, selected.ctx)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled();
  });
  it('marks raw dispatchers separately from typed specialist tools', () => {
    expect(classifyTool('meta_api_read', 'meta').exposure).toBe('raw');
    expect(classifyTool('meta_create_ad', 'meta').exposure).toBe('standard');
    expect(classifyTool('meta_advertisable_applications', 'meta').exposure).toBe('standard');
    expect(classifyTool('google_create_experiment', 'google')).toEqual({ category: 'experiments', exposure: 'specialist' });
    for (const name of ['x_web_event_tags', 'x_get_app_event_tag', 'x_update_tracking_tag', 'x_conversion_stats']) expect(classifyTool(name, 'x')).toEqual({ category: 'measurement', exposure: 'specialist' });
  });
  it('keeps the complete central asset upload and metadata flow in Standard', () => {
    // Catalog SKU imports are tracked file uploads but require the specialist catalog workflow.
    expect(classifyTool('tiktok_upload_product_set', 'tiktok').exposure).toBe('specialist');
    for (const name of [...MEDIA_UPLOAD_TOOLS].filter(name => name !== 'tiktok_upload_product_set').concat([...MEDIA_PREPARATION_TOOLS,
      'media_rename', 'media_update_metadata', 'media_delete', 'reddit_asset_upload_status',
      'spotify_get_asset', 'pinterest_get_media_upload', 'pinterest_create_video_pin',
      'linkedin_get_document', 'x_media_upload_status', 'x_register_uploaded_media'])) {
      const namespace = name.startsWith('media_') ? 'core' : name.split('_')[0]!;
      expect(classifyTool(name, namespace).exposure, name).toBe('standard');
    }
  });
  it('preserves explicit catalog metadata through the guarded write adapter', () => {
    const tool = guardedWriteTool({ name: 'spotify_update_capi_integration', namespace: 'spotify', provider: 'spotify',
      description: 'Rename an integration', payload: z.object({ name: z.string() }), kind: 'update',
      catalog: { category: 'measurement', exposure: 'specialist' } });
    expect(tool.catalog).toEqual({ category: 'measurement', exposure: 'specialist' });
    expect(tool.input.shape.pending_operation_id).toBeDefined();
    expect(tool.annotations.readOnly).toBe(false);
  });
});
