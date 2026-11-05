import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { LinkedInAdsClient, LinkedInAdsProvider, linkedinTools } from '@adport/provider-linkedin';
import { createContext } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

describe('LinkedIn measurement record widgets', () => {
  it('renders real configuration data without fetching a native tracking pixel or executing tag code', async () => {
    const account = '551000001', conversion = '1001', calls: string[] = [];
    const provider = new LinkedInAdsProvider(new LinkedInAdsClient({ accessToken: 'synthetic-only' }, async url => {
      const path = new URL(String(url)).pathname; calls.push(path);
      if (path === `/rest/adAccounts/${account}`) return Response.json({ id: Number(account), name: 'QA account', currency: 'EUR', status: 'DRAFT' });
      if (path === `/rest/conversions/${conversion}`) return Response.json({ id: Number(conversion), account: `urn:li:sponsoredAccount:${account}`, name: 'QA <literal> rule', type: 'LEAD', enabled: false, postClickAttributionWindowSize: 30, viewThroughAttributionWindowSize: 7, value: { amount: '1.234567890123', currencyCode: 'EUR' }, imagePixelTag: '<img src="https://px.ads.linkedin.com/collect/?pid=synthetic" onerror="throw 1">' });
      if (path === '/rest/insightTags') return Response.json({ elements: [{ id: 3001, sponsoredAccounts: [`urn:li:sponsoredAccount:${account}`], firstPartyTrackingEnabled: true, tag: '<script>throw new Error("executed")</script>' }] });
      throw new Error('Unexpected request');
    }));
    for (const [tool, data] of [
      ['linkedin_get_conversion', await provider.measurement.getConversion(account, conversion)],
      ['linkedin_insight_tags', await provider.measurement.insightTags(account)],
    ] as const) {
      const callTool = vi.fn(), dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } });
      try {
        const result = structuredResult(tool, 'records', data, undefined, { project_id: '203c14b1-c908-4632-9aa7-1be5de4ae9b0' }, { can_write: false }, undefined, undefined, { provider: 'linkedin', accountId: account });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: result } } }));
        const main = dom.window.document.querySelector('main')!;
        expect(main.querySelectorAll('article')).toHaveLength(1);
        expect(main.querySelector('img,script,iframe,input,button,form')).toBeNull();
        expect(callTool).not.toHaveBeenCalled();
        if (tool === 'linkedin_get_conversion') { expect(main.textContent).toContain('QA <literal> rule'); expect(main.textContent).toContain('Disabled'); expect(main.textContent).toContain('1.234567890123 EUR'); }
      } finally { dom.window.close(); }
    }
    expect(calls.every(path => path.startsWith('/rest/'))).toBe(true);
  });
  it('returns SDK-valid measurement outputs with the existing read-only host capability', async () => {
    const account = '551000001', provider = new LinkedInAdsProvider(new LinkedInAdsClient({ accessToken: 'synthetic-only' }, async url => new URL(String(url)).pathname === `/rest/adAccounts/${account}` ? Response.json({ id: Number(account), name: 'QA', currency: 'EUR', status: 'DRAFT' }) : Response.json({ elements: [], paging: { start: 0, count: 50, total: 0 } })));
    const runtime = await createContext({ providerModules: [{ provider, tools: linkedinTools(provider) }] }), server = createMcpServer({ runtime, scopes: ['tools:read'] }), host = new Client({ name: 'measurement-schema-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await host.connect(ct);
    try {
      const tools = (await host.listTools()).tools;
      for (const name of ['linkedin_insight_tags', 'linkedin_conversions']) {
        expect(tools.find(tool => tool.name === name)?.outputSchema).toMatchObject({ type: 'object', properties: { elements: { type: 'array', items: { properties: { id: { type: 'string' } } } } } });
        const result = await host.callTool({ name, arguments: { account_id: account } });
        expect(result.isError).not.toBe(true); expect(result.structuredContent).toMatchObject({ account_id: account, elements: [], _adport: { view: 'records', capabilities: { can_write: false } } });
      }
    } finally { await host.close(); await server.close(); }
  });
});
