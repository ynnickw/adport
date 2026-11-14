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

// LinkedIn-owned Creatives/Lead Forms 202608 wire contracts, inspected 2026-11-05.
describe('LinkedIn form association native widget protocol', () => {
  it('renders a compact view-only card and an exact before/after approval without any provider write', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-lead-creative-widget-')), account = '7', campaign = '8', form = '6755260984438374401', creative = 'urn:li:sponsoredCreative:9', calls: string[] = [];
    const provider = new LinkedInAdsProvider(new LinkedInAdsClient({ accessToken: 'synthetic-only' }, async (url, init) => {
      const target = decodeURIComponent(new URL(String(url)).pathname); calls.push(`${init?.method} ${target}`);
      if (init?.method !== 'GET') throw new Error('Read/preview must not mutate');
      if (target === `/rest/adAccounts/${account}`) return Response.json({ id: Number(account), name: 'QA', currency: 'USD', status: 'DRAFT' });
      if (target === `/rest/adAccounts/${account}/adCampaigns/${campaign}`) return Response.json({ id: Number(campaign), account: `urn:li:sponsoredAccount:${account}`, status: 'PAUSED', name: 'QA campaign', type: 'SPONSORED_UPDATES', objectiveType: 'LEAD_GENERATION', format: 'LEAD_GENERATION_FORM_SPONSORED_CONTENT' });
      if (target === `/rest/adAccounts/${account}/creatives/${creative}`) return Response.json({ id: creative, account: `urn:li:sponsoredAccount:${account}`, campaign: `urn:li:sponsoredCampaign:${campaign}`, intendedStatus: 'DRAFT', name: 'QA <literal> creative', content: { reference: 'urn:li:share:10' }, leadgenCallToAction: { destination: `urn:li:adForm:${form}`, label: 'LEARN_MORE' } });
      if (target === `/rest/leadForms/${form}`) return new Response(`{"id":${form},"owner":{"sponsoredAccount":"urn:li:sponsoredAccount:${account}"},"name":"QA form","state":"DRAFT","creationLocale":{"language":"en","country":"US"},"content":{"headline":{"localized":{"en_US":"QA only"}},"questions":[],"legalInfo":{}}}`, { headers: { 'content-type': 'application/json' } });
      throw new Error('Unexpected resource');
    }));
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))), providerModules: [{ provider, tools: linkedinTools(provider) }] });
    const server = createMcpServer({ runtime, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'lead-creative-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await host.connect(ct); const doms: JSDOM[] = [], callTool = vi.fn();
    try {
      const formContext = await host.callTool({ name: 'linkedin_lead_ad_context', arguments: { account_id: account, form_id: form } });
      expect(formContext.isError).not.toBe(true); expect(formContext.structuredContent).toMatchObject({ form: { id: form }, records: [{ id: form }], _adport: { view: 'records' } });
      const context = await host.callTool({ name: 'linkedin_creative_lead_form', arguments: { account_id: account, creative_id: creative } });
      expect(context.isError).not.toBe(true); expect(context.structuredContent).toMatchObject({ form: { id: form }, _adport: { view: 'creatives' } });
      const source = await provider.leadCreatives.get(account, creative);
      const preview = await host.callTool({ name: 'linkedin_set_creative_lead_form', arguments: { account_id: account, creative_id: creative, expected_creative_hash: source.creative_snapshot_hash, expected_campaign_hash: source.campaign_snapshot_hash, form_id: form, expected_form_hash: source.form!.snapshot_hash, label: 'DOWNLOAD' } });
      expect(preview.isError).not.toBe(true); expect(preview.structuredContent).toMatchObject({ status: 'pending_validation', applied: false });
      for (const [result, operation] of [[context, false], [preview, true]] as const) {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } }); doms.push(dom);
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));
        const main = dom.window.document.querySelector('main')!; expect(main.textContent).toContain('QA <literal> creative'); expect(main.querySelector('img,iframe,input,form,select')).toBeNull();
        if (operation) { expect(main.textContent).toContain('LEARN_MORE'); expect(main.textContent).toContain('DOWNLOAD'); expect(main.querySelector('[data-approve]')?.textContent).toBe('Hold to apply'); }
        else { expect(main.textContent).toContain('Lead form: QA form'); expect(main.querySelector('button')).toBeNull(); }
      }
      expect(callTool).not.toHaveBeenCalled(); expect(calls.every(call => call.startsWith('GET /rest/'))).toBe(true);
    } finally { for (const dom of doms) dom.window.close(); await host.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
