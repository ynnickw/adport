import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { LinkedInAdsClient, LinkedInAdsProvider } from '@adport/provider-linkedin';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

describe('LinkedIn demographic read widget',()=>{
  it('shows one country for its native facet variants',async()=>{
    const account='551814436',urn='urn:li:geo:101282230',facets=['locations','profileLocations','ipLocations','contextualCountries'];
    const provider=new LinkedInAdsProvider(new LinkedInAdsClient({accessToken:'qa-only'},async(url)=>new URL(String(url)).pathname===`/rest/adAccounts/${account}`?Response.json({id:Number(account),name:'QA',currency:'USD',status:'DRAFT'}):Response.json({elements:facets.map(facet=>({urn,name:'Germany',facetUrn:`urn:li:adTargetingFacet:${facet}`}))})));
    const data=await provider.reporting.resolveEntities({account_id:account,urns:[urn]});
    const dom=new JSDOM(ADPORT_UI_HTML,{runScripts:'dangerously',url:'https://widget.example'});
    try {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:dom.window.parent,data:{jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:structuredResult('linkedin_resolve_targeting_entities','records',data)}}}));
      expect(dom.window.document.querySelectorAll('article')).toHaveLength(1);expect(dom.window.document.querySelector('.record-name')?.textContent).toBe('Germany');expect(data.elements).toHaveLength(4);expect(data.entities[0]?.facet_urns).toHaveLength(4);
    }finally{dom.window.close();}
  });
  it.each([false,true])('renders actual provider output with empty=%s without treating filters as records or implying exact totals',async empty=>{
    const account='551814436',urn='urn:li:industry:4',calls:string[]=[];
    const client=new LinkedInAdsClient({accessToken:'qa-only'},async(url)=>{
      const path=new URL(String(url)).pathname;calls.push(path);
      if(path===`/rest/adAccounts/${account}`)return Response.json({id:Number(account),name:'QA account',currency:'EUR',status:'DRAFT'});
      if(path==='/rest/adAnalytics')return Response.json({elements:empty?[]:[{pivotValues:[urn],dateRange:{start:{year:2026,month:10,day:1},end:{year:2026,month:10,day:31}},impressions:123,clicks:0,costInLocalCurrency:'1.234567890123'}]});
      if(path==='/rest/adTargetingEntities')return Response.json({elements:[{urn,name:'Software <literal>'}]});
      throw new Error('Unexpected native read');
    });
    const provider=new LinkedInAdsProvider(client),data=await provider.reporting.demographics({account_id:account,pivot:'MEMBER_INDUSTRY',date_range:{start:'2026-10-01',end:'2026-10-31'},resolve_names:true});
    const callTool=vi.fn(),dom=new JSDOM(ADPORT_UI_HTML,{runScripts:'dangerously',url:'https://widget.example',beforeParse(window){Object.defineProperty(window,'openai',{value:{callTool}});}});
    try {
      const result=structuredResult('linkedin_demographic_report','records',data,undefined,{project_id:'203c14b1-c908-4632-9aa7-1be5de4ae9b0'},{can_write:false},undefined,undefined,{provider:'linkedin',accountId:account});
      dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:dom.window.parent,data:{jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:result}}}));
      const main=dom.window.document.querySelector('main')!;
      expect(main.textContent).toContain('approximate');expect(main.textContent).toContain('three-event privacy threshold');
      expect(main.querySelectorAll('article')).toHaveLength(empty?0:1);
      if(empty)expect(main.textContent).toContain('No report rows returned.');
      else {
        expect(main.querySelector('.record-name')?.textContent).toBe('Software <literal>');
        expect(main.querySelector('.record-fields')?.textContent).toContain('1.234567890123 EUR');
        expect(main.querySelector('.record-fields')?.textContent).toContain('0');
        expect(main.querySelector('.record-fields')?.textContent).toContain('2026-10-01 – 2026-10-31');
      }
      expect(main.querySelector('input,button,select,form')).toBeNull();expect(callTool).not.toHaveBeenCalled();
      expect(calls.filter(path=>path==='/rest/adAnalytics')).toHaveLength(1);
    }finally{dom.window.close();}
  });
});
