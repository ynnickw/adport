import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine } from '@adport/core';
import { LinkedInAdsClient, LinkedInAdsProvider, linkedinTools } from '@adport/provider-linkedin';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML } from '../src/ui.js';

describe('LinkedIn native lead form widgets', () => {
  it('returns SDK-valid exact IDs and scoped paging, then renders a safe configuration card and name-only review', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-lead-form-widget-')), account = '551000001', formId = '6755260984438374401', calls: string[] = [];
    const rawForm = `{"id":${formId},"owner":{"sponsoredAccount":"urn:li:sponsoredAccount:${account}"},"creationLocale":{"country":"US","language":"en"},"name":"QA <literal> form","state":"DRAFT","hiddenFields":[],"content":{"headline":{"localized":{"en_US":"<img src=https://unexpected.invalid/pixel>"}},"questions":[],"legalInfo":{}}}`;
    const provider = new LinkedInAdsProvider(new LinkedInAdsClient({ accessToken: 'synthetic-only' }, async (url, init) => {
      const target = new URL(String(url)); calls.push(`${init?.method ?? 'GET'} ${target.pathname}`);
      if (init?.method && init.method !== 'GET') throw new Error('Widget preview must not write');
      if (target.pathname === `/rest/adAccounts/${account}`) return Response.json({ id: Number(account), name: 'QA', currency: 'USD', status: 'DRAFT' });
      if (target.pathname === '/rest/leadForms') return new Response(`{"elements":[${rawForm}],"paging":{"start":0,"count":1,"total":2,"links":[]}}`, { headers: { 'content-type': 'application/json' } });
      if (target.pathname === `/rest/leadForms/${formId}`) return new Response(rawForm, { headers: { 'content-type': 'application/json' } });
      throw new Error('Unexpected resource');
    }));
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))), providerModules: [{ provider, tools: linkedinTools(provider) }] });
    const server = createMcpServer({ runtime, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'lead-form-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await host.connect(ct);
    const doms: JSDOM[] = [], callTool = vi.fn();
    try {
      const tools = (await host.listTools()).tools;
      expect(tools.find(tool => tool.name === 'linkedin_get_lead_form')?.outputSchema).toMatchObject({ type: 'object', properties: { form: { properties: { id: { type: 'string' } } } } });
      const list = await host.callTool({ name: 'linkedin_lead_forms', arguments: { account_id: account, count: 1 } });
      expect(list.isError).not.toBe(true);
      expect(list.structuredContent).toMatchObject({ elements: [{ id: formId }], next_start: 1, _adport: { view: 'records', next: { arguments: { account_id: account, start: 1, count: 1 } } } });
      const baseline = await provider.leadForms.get(account, formId);
      const preview = await host.callTool({ name: 'linkedin_update_lead_form', arguments: { account_id: account, form_id: formId, expected_snapshot_hash: baseline.form.snapshot_hash, name: 'Renamed QA form' } });
      expect(preview.isError).not.toBe(true);
      expect(preview.structuredContent).toMatchObject({ status: 'pending_validation', applied: false, preview: { review: { fields: [{ label: 'Name', before: 'QA <literal> form', after: 'Renamed QA form' }] } } });
      for (const [result, operation] of [[list, false], [preview, true]] as const) {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } }); doms.push(dom);
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));
        const main = dom.window.document.querySelector('main')!;
        expect(main.textContent).toContain('QA <literal> form'); expect(main.querySelector('img,script,iframe,input,form')).toBeNull();
        if (operation) { expect(main.querySelector('.review-before')?.textContent).toBe('QA <literal> form'); expect(main.querySelector('.review-after')?.textContent).toBe('Renamed QA form'); expect(main.querySelector('[data-approve]')?.textContent).toBe('Hold to apply'); }
        else expect(main.querySelectorAll('article')).toHaveLength(1);
      }
      expect(callTool).not.toHaveBeenCalled(); expect(calls.every(call => call.startsWith('GET /rest/'))).toBe(true);
    } finally { for (const dom of doms) dom.window.close(); await host.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
