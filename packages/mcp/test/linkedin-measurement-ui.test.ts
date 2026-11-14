import { JSDOM } from 'jsdom';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LinkedInAdsClient, LinkedInAdsProvider, linkedinTools } from '@adport/provider-linkedin';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

describe('LinkedIn measurement record widgets', () => {
  it('renders an actionable account-bound tag review from the actual guarded SDK preview without writing to LinkedIn', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-tag-review-'));
    const account = '551000001', requests: string[] = [];
    const provider = new LinkedInAdsProvider(new LinkedInAdsClient({ accessToken: 'synthetic-only' }, async (url, init) => {
      requests.push(init?.method ?? 'GET');
      if (init?.method && init.method !== 'GET') throw new Error('Preview must not mutate LinkedIn');
      return new URL(String(url)).pathname === `/rest/adAccounts/${account}`
        ? Response.json({ id: Number(account), name: 'QA', currency: 'EUR', status: 'DRAFT' })
        : Response.json({ elements: [] });
    }));
    const pending = new PendingStore(path.join(dir, 'pending'));
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, pending, new AuditLog(path.join(dir, 'audit'))), providerModules: [{ provider, tools: linkedinTools(provider) }] });
    const server = createMcpServer({ runtime, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'tag-review-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await host.connect(ct);
    let dom: JSDOM | undefined;
    try {
      const baseline = await provider.measurement.insightTags(account);
      const args = { account_id: account, expected_account_hash: baseline.account_snapshot_hash };
      const result = await host.callTool({ name: 'linkedin_create_insight_tag', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'pending_validation', applied: false, preview: { review: {
        provider: 'linkedin', accountId: account, kind: 'create',
        fields: [{ label: 'Account', after: account }, { label: 'First-party tracking (native default)', after: true }],
      } }, _adport: { approval: { arguments: args }, capabilities: { can_write: true } } });
      const pendingId = (result.structuredContent as Record<string, unknown>).pending_operation_id as string;
      expect((await pending.get(pendingId))?.preview.review?.fields).toHaveLength(2);
      const callTool = vi.fn();
      dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } });
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));
      const main = dom.window.document.querySelector('main')!;
      expect(main.textContent).toContain('First-party tracking (native default)');
      expect(main.textContent).toContain(account);
      expect(main.querySelector('[data-approve]')?.textContent).toBe('Hold to apply');
      expect(main.textContent).not.toContain('No change details were returned');
      expect(callTool).not.toHaveBeenCalled();
      expect(requests.every(method => method === 'GET')).toBe(true);
    } finally { dom?.window.close(); await host.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('keeps a name-only edit review actionable and shows the observed old name', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-rule-review-')), account = '551000001', conversion = '1001';
    const requests: string[] = [];
    const provider = new LinkedInAdsProvider(new LinkedInAdsClient({ accessToken: 'synthetic-only' }, async (url, init) => {
      requests.push(init?.method ?? 'GET');
      if (init?.method && init.method !== 'GET') throw new Error('Preview must not mutate LinkedIn');
      return new URL(String(url)).pathname === `/rest/adAccounts/${account}`
        ? Response.json({ id: Number(account), name: 'QA', currency: 'EUR', status: 'DRAFT' })
        : Response.json({ id: Number(conversion), account: `urn:li:sponsoredAccount:${account}`, name: 'Original QA rule', type: 'LEAD', enabled: false });
    }));
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))), providerModules: [{ provider, tools: linkedinTools(provider) }] });
    const server = createMcpServer({ runtime, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'rule-review-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await host.connect(ct);
    let dom: JSDOM | undefined;
    try {
      const baseline = await provider.measurement.getConversion(account, conversion);
      const result = await host.callTool({ name: 'linkedin_update_conversion', arguments: { account_id: account, conversion_id: conversion, expected_snapshot_hash: baseline.conversion.snapshot_hash, name: 'Renamed QA rule' } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'pending_validation', applied: false, preview: { review: {
        subject: 'Original QA rule', fields: [{ label: 'Name', before: 'Original QA rule', after: 'Renamed QA rule' }],
      } } });
      const callTool = vi.fn();
      dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } });
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));
      const main = dom.window.document.querySelector('main')!;
      expect(main.querySelector('.review-before')?.textContent).toBe('Original QA rule');
      expect(main.querySelector('.review-after')?.textContent).toBe('Renamed QA rule');
      expect(main.querySelector('[data-approve]')?.textContent).toBe('Hold to apply');
      expect(callTool).not.toHaveBeenCalled(); expect(requests.every(method => method === 'GET')).toBe(true);
    } finally { dom?.window.close(); await host.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
  });
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
        const result = structuredResult(tool, 'records', data, undefined, { project_id: 'b310e750-d001-4427-8184-09bd05920e01' }, { can_write: false }, undefined, undefined, { provider: 'linkedin', accountId: account });
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
