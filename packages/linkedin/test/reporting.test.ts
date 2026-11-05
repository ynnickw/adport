import { describe, expect, it } from 'vitest';
import { LinkedInAdsClient } from '../src/client.js';
import { LinkedInAdsProvider } from '../src/provider.js';
import { linkedinTools } from '../src/tools.js';
import { demographicInput, resolveEntitiesInput } from '../src/reporting.js';

// Official Marketing202608 Reporting, Metrics Available and Ad Targeting
// (Find Entities by URNs) wire contracts checked 2026-11-05.
const A='551814436', C='145282384', U='urn:li:industry:4';
const range={start:'2026-10-01',end:'2026-10-31'};
const nativeRange={start:{year:2026,month:10,day:1},end:{year:2026,month:10,day:31}};
const args={account_id:A,pivot:'MEMBER_INDUSTRY' as const,date_range:range};
const row={pivotValues:[U],dateRange:nativeRange,impressions:12,clicks:0,costInLocalCurrency:'1.234567890123456789'};
type Call={url:URL;init:RequestInit};
function fixture(handler?: (call:Call)=>unknown|Response) {
  const calls:Call[]=[];
  const client=new LinkedInAdsClient({accessToken:'qa-access'},async(url,init={})=>{
    const call={url:new URL(String(url)),init};calls.push(call);const result=handler?.(call);
    if(result!==undefined)return result instanceof Response?result:Response.json(result);
    if(call.url.pathname===`/rest/adAccounts/${A}`)return Response.json({id:Number(A),name:'QA account',currency:'EUR',status:'DRAFT'});
    if(call.url.pathname===`/rest/adAccounts/${A}/adCampaigns/${C}`)return Response.json({id:Number(C),name:'QA campaign',account:`urn:li:sponsoredAccount:${A}`,status:'PAUSED'});
    if(call.url.pathname==='/rest/adAnalytics')return Response.json({elements:[row],paging:{start:0,count:10,links:[]}});
    if(call.url.pathname==='/rest/adTargetingEntities')return Response.json({elements:[{urn:U,name:'Software',facetUrn:'urn:li:adTargetingFacet:industries'}],paging:{start:0,count:2147483647,links:[]}});
    throw new Error('Unexpected native request');
  });
  return {provider:new LinkedInAdsProvider(client),calls};
}

describe('LinkedIn professional demographic reporting',()=>{
  it('registers named read-only tools without native access',()=>{
    const tools=linkedinTools(new Proxy({} as LinkedInAdsProvider,{get(){throw new Error('eager access');}}));
    for(const name of ['linkedin_demographic_report','linkedin_resolve_targeting_entities'])expect(tools.find(tool=>tool.name===name)).toMatchObject({presentation:'records',annotations:{readOnly:true,destructive:false,openWorld:false}});
  });
  it('uses native account-scoped analytics, inclusive UTC dates, projection and version headers',async()=>{
    const f=fixture(),result=await f.provider.reporting.demographics({...args,campaign_ids:[C]});const request=f.calls.at(-1)!;
    expect(request.init).toMatchObject({method:'GET',redirect:'error',headers:{authorization:'Bearer qa-access','Linkedin-Version':'202608','X-Restli-Protocol-Version':'2.0.0','X-RestLi-Method':'FINDER'}});
    expect(request.init.body).toBeUndefined();
    expect(Object.fromEntries(request.url.searchParams)).toEqual({q:'analytics',pivot:'MEMBER_INDUSTRY',timeGranularity:'ALL',dateRange:'(start:(year:2026,month:10,day:1),end:(year:2026,month:10,day:31))',accounts:`List(urn:li:sponsoredAccount:${A})`,campaigns:`List(urn:li:sponsoredCampaign:${C})`,fields:'pivotValues,dateRange,impressions,clicks,costInLocalCurrency'});
    expect(request.url.href).toContain('accounts=List(urn%3Ali%3AsponsoredAccount%3A');
    expect(f.calls.map(call=>call.url.pathname)).toEqual([`/rest/adAccounts/${A}`,`/rest/adAccounts/${A}/adCampaigns/${C}`,'/rest/adAnalytics']);
    expect(result.rows[0]).toEqual({urn:U,date_range:range,metrics:{impressions:12,clicks:0,costInLocalCurrency:'1.234567890123456789'}});
    expect(result.records[0]).toMatchObject({name:U,clicks:0,costInLocalCurrency:'1.234567890123456789 EUR'});
    expect(result).toMatchObject({currency:'EUR',truncated:false,complete:false,coverage:{approximate:true,minimum_events:3,pagination_supported:false}});
  });
  it.each([
    ['MEMBER_COMPANY_SIZE','urn:li:staffCountRange:(10001,2147483647)'],['MEMBER_INDUSTRY',U],['MEMBER_SENIORITY','urn:li:seniority:5'],['MEMBER_JOB_TITLE','urn:li:title:123'],['MEMBER_JOB_FUNCTION','urn:li:function:1'],['MEMBER_COUNTRY_V2','urn:li:geo:103644278'],['MEMBER_REGION_V2','urn:li:geo:103644278'],['MEMBER_COMPANY','urn:li:organization:1035'],
  ] as const)('preserves native %s identities',async(pivot,urn)=>{
    const f=fixture(call=>call.url.pathname==='/rest/adAnalytics'?{elements:[{...row,pivotValues:[urn]}]}:undefined);
    expect((await f.provider.reporting.demographics({...args,pivot})).rows[0]?.urn).toBe(urn);
  });
  it.each([
    {pivot:'MEMBER_DESIGNATED_MARKET_AREA'}, {metrics:['conversionValueInLocalCurrency']}, {metrics:['approximateMemberReach']}, {metrics:['cardClicks']}, {metrics:['impressions','impressions']}, {date_range:{start:'2026-02-30',end:'2026-03-01'}}, {date_range:{start:'2026-11-02',end:'2026-11-01'}}, {campaign_ids:[C,C]}, {limit:0}, {start:10},
  ])('rejects unsupported fields, invalid dates and invented pagination %j',input=>{
    expect(demographicInput.safeParse({...args,...input}).success).toBe(false);
  });
  it('rejects a foreign account or campaign before analytics is requested',async()=>{
    for(const foreignCampaign of [false,true]){
      const f=fixture(call=>call.url.pathname===(foreignCampaign?`/rest/adAccounts/${A}/adCampaigns/${C}`:`/rest/adAccounts/${A}`)?foreignCampaign?{id:Number(C),name:'Foreign',account:'urn:li:sponsoredAccount:99',status:'PAUSED'}:{id:99,name:'Foreign',currency:'EUR',status:'DRAFT'}:undefined);
      await expect(f.provider.reporting.demographics({...args,campaign_ids:[C]})).rejects.toThrow(/mismatch/);expect(f.calls.some(call=>call.url.pathname==='/rest/adAnalytics')).toBe(false);
    }
  });
  it('preserves absent/null metrics and distinguishes USD spend from account currency',async()=>{
    const f=fixture(call=>call.url.pathname==='/rest/adAnalytics'?{elements:[{pivotValues:[U],dateRange:nativeRange,impressions:null,costInUsd:'0.000000001'}]}:undefined);
    const result=await f.provider.reporting.demographics({...args,metrics:['impressions','clicks','costInUsd']});
    expect(result.rows[0]?.metrics).toEqual({impressions:null,clicks:null,costInUsd:'0.000000001'});
    expect(result.records[0]).toMatchObject({impressions:null,clicks:null,costInUsd:'0.000000001 USD'});
  });
  it.each([
    {elements:[{...row,pivotValues:['urn:li:organization:4']}]},
    {elements:[row,row]},
    {elements:[{...row,dateRange:{...nativeRange,start:{year:2026,month:9,day:1}}}]},
    {elements:[{...row,dateRange:{...nativeRange,end:{year:2026,month:10,day:30}}}]},
    {elements:[{...row,impressions:-1}]},
    {elements:[{...row,clicks:Number.MAX_SAFE_INTEGER+1}]},
    {elements:[{...row,costInLocalCurrency:1.25}]},
  ])('rejects malformed, incorrectly scoped or duplicate native results %#',async response=>{
    const f=fixture(call=>call.url.pathname==='/rest/adAnalytics'?response:undefined);
    await expect(f.provider.reporting.demographics(args)).rejects.toThrow();
  });
  it('keeps daily periods separate and rejects a multi-day DAILY row',async()=>{
    const date={year:2026,month:10,day:3};
    const f=fixture(call=>call.url.pathname==='/rest/adAnalytics'?{elements:[{...row,dateRange:{start:date,end:date}}]}:undefined);
    expect((await f.provider.reporting.demographics({...args,time_granularity:'DAILY'})).rows[0]?.date_range).toEqual({start:'2026-10-03',end:'2026-10-03'});
    await expect(fixture().provider.reporting.demographics({...args,time_granularity:'DAILY'})).rejects.toThrow('native reporting dates');
  });
  it('does not manufacture continuation requests for native or local limits',async()=>{
    const second={...row,pivotValues:['urn:li:industry:5']};
    const f=fixture(call=>call.url.pathname==='/rest/adAnalytics'?{elements:[row,second],paging:{start:0,count:2,total:3,links:[{rel:'next'}]}}:undefined);
    const result=await f.provider.reporting.demographics({...args,limit:1});
    expect(result).toMatchObject({returned_native_rows:2,truncated:true,complete:false});expect(result.rows).toHaveLength(1);expect(result).not.toHaveProperty('next_start');
    expect(f.calls.filter(call=>call.url.pathname==='/rest/adAnalytics')).toHaveLength(1);
  });
  it('keeps empty activity/access ambiguity and skips optional empty name lookups',async()=>{
    const f=fixture(call=>call.url.pathname==='/rest/adAnalytics'?{elements:[]}:undefined);
    const result=await f.provider.reporting.demographics({...args,resolve_names:true});expect(result.rows).toEqual([]);expect(result.complete).toBe(false);expect(result.notes.join(' ')).toContain('insufficient native data access');expect(f.calls).toHaveLength(2);
  });
  it('resolves only exact returned URNs with the native single-node finder and locale',async()=>{
    const f=fixture(),result=await f.provider.reporting.demographics({...args,resolve_names:true,locale:{language:'de',country:'DE'}});
    const request=f.calls.at(-1)!;
    expect(Object.fromEntries(request.url.searchParams)).toEqual({q:'urns',queryVersion:'QUERY_USES_URNS',fetchType:'SINGLE_NODE',urns:`List(${U})`,locale:'(language:de,country:DE)'});
    expect(result.rows[0]?.name).toBe('Software');expect(result.records[0]?.name).toBe('Software');expect(f.calls.every(call=>call.init.method==='GET')).toBe(true);
  });
  it('preserves analytics if optional name resolution is denied and never repeats the report',async()=>{
    const f=fixture(call=>call.url.pathname==='/rest/adTargetingEntities'?Response.json({message:'denied'},{status:403}):undefined);
    const result=await f.provider.reporting.demographics({...args,resolve_names:true});expect(result.rows[0]?.urn).toBe(U);expect(result.rows[0]).not.toHaveProperty('name');expect(result.notes.join(' ')).toContain('Optional name lookup was not confirmed');expect(f.calls.filter(call=>call.url.pathname==='/rest/adAnalytics')).toHaveLength(1);
  });
  it('returns missing names explicitly and rejects foreign/duplicate URN resolution',async()=>{
    const f=fixture(call=>call.url.pathname==='/rest/adTargetingEntities'?{elements:[]}:undefined);
    expect((await f.provider.reporting.resolveEntities({account_id:A,urns:[U]})).unresolved_urns).toEqual([U]);
    for(const elements of [[{urn:'urn:li:industry:5',name:'Other'}],[{urn:U,name:'First'},{urn:U,name:'Duplicate'}]]){
      const bad=fixture(call=>call.url.pathname==='/rest/adTargetingEntities'?{elements}:undefined);await expect(bad.provider.reporting.resolveEntities({account_id:A,urns:[U]})).rejects.toThrow('unrequested or duplicate');
    }
    expect(resolveEntitiesInput.safeParse({account_id:A,urns:[U,U]}).success).toBe(false);expect(resolveEntitiesInput.safeParse({account_id:A,urns:['urn:li:person:123']}).success).toBe(false);
  });
});
