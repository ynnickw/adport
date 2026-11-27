import { describe, expect, it, vi } from 'vitest';
import { createContext, MockProvider, selectRuntimeCatalog, withProjectRouting, type AdProvider, type ToolProfile } from '../src/index.js';
function website(id: 'ga4' | 'matomo') {
  const listGoals = vi.fn(async () => [{ id: '7', name: id + ' goal' }]);
  return { listGoals, module: { provider: Object.assign(new MockProvider() as AdProvider, {
    id, acquisitionAnalytics: { listGoals, acquisitionReport: vi.fn() },
  }), tools: [] } };
}
const names = ['analytics_acquisition_report', 'analytics_goals'];
describe('shared website tools', () => {
  it.each<ToolProfile>(['standard', 'reporting', 'full'])('exposes exactly two tools in %s and enforces provider selection at execution', async profile => {
    const matomo = website('matomo'), ga4 = website('ga4');
    const runtime = await createContext({ providerModules: [matomo.module, ga4.module] });
    const both = selectRuntimeCatalog(runtime, { profile, providers: ['ga4', 'matomo'] });
    expect(both.registry.list().filter(t => t.namespace === 'analytics').map(t => t.name).sort()).toEqual(names);
    expect(both.registry.list().some(t => /^(ga4|matomo)_/.test(t.name))).toBe(false);
    const selected = selectRuntimeCatalog(runtime, { profile, providers: ['matomo'] });
    expect(selected.registry.get('analytics_goals').input.safeParse({ provider: 'ga4', account_id: '1' }).success).toBe(false);
    await expect(selected.registry.call('analytics_goals', { provider: 'ga4', account_id: '1' }, selected.ctx)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(ga4.listGoals).not.toHaveBeenCalled();
    expect(await selected.registry.call('analytics_goals', { provider: 'matomo', account_id: '1' }, selected.ctx)).toMatchObject({ goals: [{ name: 'matomo goal' }] });
    expect(await selected.registry.call('capabilities_list', { provider: 'ga4' }, selected.ctx)).toMatchObject({ total_matches: 2, tools: [
      { enabled: false, blockers: ['platform_disabled'] }, { enabled: false, blockers: ['platform_disabled'] }] });
    expect(selectRuntimeCatalog(runtime, { profile, providers: ['gsc'] }).registry.list().some(t => t.namespace === 'analytics')).toBe(false);
  });
  it('resolves the current project for every read when site and goal IDs overlap', async () => {
    const first = website('matomo'), second = website('matomo');
    second.listGoals.mockResolvedValue([{ id: '7', name: 'Second brand' }]);
    const a = await createContext({ providerModules: [first.module] }), b = await createContext({ providerModules: [second.module] });
    const id = '00000000-0000-4000-8000-000000000002';
    const routed = withProjectRouting(a, { list: async () => [], resolve: async project => {
      if (project !== id) throw Error('Foreign project');
      return b;
    } });
    const args = { provider: 'matomo', account_id: '1', project_id: id };
    expect(await routed.registry.call('analytics_goals', args, routed.ctx)).toMatchObject({ goals: [{ id: '7', name: 'Second brand' }] });
    expect(first.listGoals).not.toHaveBeenCalled();
    expect(second.listGoals).toHaveBeenCalledWith('1');
  });
  it('rejects visitor data, raw parameters, writes and invalid ranges before reading the provider', async () => {
    const ga4 = website('ga4');
    const runtime = await createContext({ providerModules: [ga4.module] });
    const args = { provider: 'ga4', account_id: '1', start_date: '2026-11-01', end_date: '2026-11-02' };
    for (const extra of [{ segment: 'visitorId==1' }, { method: 'Goals.addGoal' }, { metrics: ['users'] }, { end_date: '2026-10-01' }, { goal_ids: ['x', 'x'] }])
      await expect(runtime.registry.call('analytics_acquisition_report', { ...args, ...extra }, runtime.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(ga4.module.provider.acquisitionAnalytics.acquisitionReport).not.toHaveBeenCalled();
  });
});
