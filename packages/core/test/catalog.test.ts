import { describe, expect, it, vi } from 'vitest';
import { createContext, selectRuntimeCatalog } from '../src/context.js';
import { MockProvider } from '../src/testing/mock-provider.js';
import { classifyTool } from '../src/tools/catalog.js';

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
    expect(classifyTool('google_create_experiment', 'google')).toEqual({ category: 'experiments', exposure: 'specialist' });
  });
});
