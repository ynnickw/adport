import { mkdtemp,rm,readdir,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,describe,expect,it } from 'vitest';
import { AuditLog,createContext,DEFAULT_POLICY,PendingStore,PolicyEngine,type WriteOperation } from '@adport/core';
import { pinterestTools } from '../src/tools.js';
import { createCampaignSchema } from '../src/schemas.js';
import { campaignDailyBudget } from '../src/campaign-budgets.js';
import { campaignBudgetFixture,CB_ACCOUNT,CB_CAMPAIGN,CB_CREATED,CB_PRIVATE } from './campaign-budget-fixture.js';

type Row=Record<string,any>;
const tool='pinterest_set_campaign_daily_budget',guard={forcePausedCreation:true},dirs:string[]=[],op=(payload:Row,name=tool,kind:WriteOperation['kind']='update'):WriteOperation=>({provider:'pinterest',accountId:CB_ACCOUNT,tool:name,kind,payload}),absent=(value:unknown)=>expect(JSON.stringify(value)).not.toContain('PRIVATE-LINK');
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
// Pinterest-owned OpenAPI5.28.0 at51aca009 and official fixed/average budget
// documentation, inspected2026-11-06. Native data and endpoints here are mocked.
describe('Pinterest fixed/average daily configuration',()=>{
  it('defines two lazy typed tools and retains the same shared create definition',()=>{
    const f=campaignBudgetFixture(),tools=pinterestTools(new Proxy(f.provider,{get(){throw new Error('Eager access');}}));expect(new Set(tools.map(tool=>tool.name)).size).toBe(tools.length);expect(tools.filter(tool=>tool.name==='pinterest_create_campaign')).toHaveLength(1);expect(tools.find(tool=>tool.name==='pinterest_campaign_budget_context')!.annotations.readOnly).toBe(true);expect(tools.find(value=>value.name===tool)!.input.shape.pending_operation_id).toBeDefined();
  });
  it('reads scoped currency/mode/context without exposing tracking URLs or sending writes',async()=>{
    const f=campaignBudgetFixture(),result=await f.provider.campaignBudgets.publicContext(f.selection);expect(result).toMatchObject({records:[{id:CB_CAMPAIGN,budget_mode:'FIXED',budget_micros:100_000_000,currency:'EUR',status:'PAUSED'}]});absent(result);expect(f.writes()).toHaveLength(0);expect(f.calls.some(call=>call.url.pathname===`/v5/ad_accounts/${CB_ACCOUNT}`)).toBe(true);
  });
  it.each(['AVERAGE','FIXED'] as const)('PATCHes exact native %s daily fields and preserves omitted configuration',async mode=>{
    const f=campaignBudgetFixture();if(mode==='FIXED')f.campaign.is_flexible_daily_budgets=true;const args=await f.args(mode),preview=await f.provider.previewWrite(op(args),guard);expect(preview.budgetDeltas).toEqual([{target:`campaign ${CB_CAMPAIGN} configured ${mode==='AVERAGE'?'average daily budget':'fixed daily cap'}`,fromMicros:100_000_000,toMicros:110_000_000,currency:'EUR'}]);absent(preview);expect(f.writes()).toHaveLength(0);const result=await f.provider.applyWrite(op(args),guard);expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.body).toEqual([{id:CB_CAMPAIGN,daily_spend_cap:110_000_000,is_flexible_daily_budgets:mode==='AVERAGE'}]);expect(result.details).toMatchObject({configuration_readback:'VERIFIED',status:'PAUSED',omitted_configuration_preserved:true,daily_delivery_ceiling_verified:false,budget_mode:mode});expect(f.campaign).toMatchObject({native_future_setting:true,tracking_urls:{click:[CB_PRIVATE]},start_time:1793937600,end_time:1893456000,bid_options:{placement_multipliers:{SEARCH:1}},is_performance_plus:false});absent(result);
  });
  it('changes only mode with the current configured amount and updates an existing average without changing mode',async()=>{
    const f=campaignBudgetFixture(),args=await f.args();delete args.budget_micros;await f.provider.applyWrite(op(args),guard);expect(f.writes()[0]!.body).toEqual([{id:CB_CAMPAIGN,is_flexible_daily_budgets:true}]);const result=await f.provider.applyWrite(op(await f.args()),guard);expect(result.details).toMatchObject({budget_mode:'AVERAGE',configured_budget_micros:110_000_000});
  });
  it('omits an unchanged mode on amount-only PATCH and verifies a documented partial native receipt by independent readback',async()=>{
    const f=campaignBudgetFixture();f.campaign.is_flexible_daily_budgets=true;const args=await f.args();f.state.hook=({init,body})=>{if(init.method==='PATCH'){Object.assign(f.campaign,body![0]);return Response.json({items:[{data:{id:CB_CAMPAIGN}}]});}};const result=await f.provider.applyWrite(op(args),guard);expect(f.writes()[0]!.body).toEqual([{id:CB_CAMPAIGN,daily_spend_cap:110_000_000}]);expect(result.details).toMatchObject({configuration_readback:'VERIFIED',budget_mode:'AVERAGE',omitted_configuration_preserved:true});
  });
  it('recognizes native per-item exceptions inside HTTP200 without interpreting them as successful application',async()=>{
    const f=campaignBudgetFixture(),args=await f.args();f.state.hook=({init})=>init.method==='PATCH'?Response.json({items:[{data:{id:CB_CAMPAIGN},exceptions:[{code:4042,message:CB_PRIVATE}]}]}):undefined;try{await f.provider.applyWrite(op(args),guard);expect.fail('Expected batch failure');}catch(error){expect(error).toMatchObject({details:{verification_phase:'NATIVE_BATCH_ERRORS',native_errors:[{code:4042,message_present:true}]}});absent(error);}expect(f.writes()).toHaveLength(1);
  });
  it('requires variable/reset acknowledgement for either current or requested average mode and rejects unchanged input',async()=>{
    const f=campaignBudgetFixture(),args=await f.args();expect(campaignDailyBudget.safeParse({...args,acknowledge_variable_daily_spend:undefined}).success).toBe(false);expect(campaignDailyBudget.safeParse({...args,acknowledge_averaging_reset:undefined}).success).toBe(false);f.campaign.is_flexible_daily_budgets=true;const fixed=await f.args('FIXED');delete (fixed as Row).acknowledge_variable_daily_spend;await expect(f.provider.applyWrite(op(fixed),guard)).rejects.toThrow('acknowledgements');const unchanged=await f.args('AVERAGE',100_000_000);await expect(f.provider.applyWrite(op(unchanged),guard)).rejects.toThrow('No daily-budget change');expect(f.writes()).toHaveLength(0);
  });
  it.each(['non-cbo','both-caps','no-cap','lifetime','unknown-mode','archived','deleted-draft'])('rejects %s campaign semantics without a write',async mode=>{
    const f=campaignBudgetFixture();if(mode==='non-cbo')f.campaign.is_campaign_budget_optimization=false;if(mode==='both-caps')f.campaign.lifetime_spend_cap=1;if(mode==='no-cap')f.campaign.daily_spend_cap=0;if(mode==='lifetime'){f.campaign.daily_spend_cap=0;f.campaign.lifetime_spend_cap=100_000_000;}if(mode==='unknown-mode')delete f.campaign.is_flexible_daily_budgets;if(mode==='archived')f.campaign.status='ARCHIVED';if(mode==='deleted-draft')f.campaign.status='DELETED_DRAFT';await expect(f.provider.applyWrite(op(await f.args()),guard)).rejects.toThrow('editable CBO');expect(f.writes()).toHaveLength(0);
  });
  it.each(['currency','owner','amount','mode','status','schedule','unknown','project','native-account','native-campaign'])('rejects changed %s context before applying',async mode=>{
    const f=campaignBudgetFixture(),args=await f.args();if(mode==='currency')f.state.account.currency='USD';if(mode==='owner')f.state.account.owner.username='Other';if(mode==='amount')f.campaign.daily_spend_cap=90_000_000;if(mode==='mode')f.campaign.is_flexible_daily_budgets=true;if(mode==='status')f.campaign.status='ACTIVE';if(mode==='schedule')f.campaign.end_time=1893455000;if(mode==='unknown')f.campaign.native_future_setting=false;if(mode==='project')f.state.scopeId='other';if(mode==='native-account')f.state.account.id='1';if(mode==='native-campaign')f.campaign.ad_account_id='1';await expect(f.provider.applyWrite(op(args),guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('ignores only native observation/timestamp changes when configuration is unchanged',async()=>{
    const f=campaignBudgetFixture(),args=await f.args();f.campaign.updated_time=1793939000;f.campaign.summary_status='OBSERVATION_CHANGED';await f.provider.applyWrite(op(args),guard);expect(f.writes()).toHaveLength(1);
  });
  it.each(['USD?','',undefined])('refuses an unconfirmed currency %s without inventing a default',async currency=>{
    const f=campaignBudgetFixture();f.state.account.currency=currency;await expect(f.provider.applyWrite(op(await f.args()),guard)).rejects.toThrow('currency is unavailable');expect(f.writes()).toHaveLength(0);
  });
  it.each(['scope','status','mode','amount','preserved','partial','malformed','readback-denied'])('keeps %s native mutation/readback failure unconfirmed and retains known IDs without replay',async mode=>{
    const f=campaignBudgetFixture(),args=await f.args();let submitted=false;f.state.hook=({url,init,body})=>{if(init.method==='PATCH'){submitted=true;if(mode==='partial')return Response.json({items:[{data:{id:CB_CAMPAIGN},exceptions:[{message:CB_PRIVATE}]}]});if(mode==='malformed')return Response.json({items:[{data:{id:CB_CAMPAIGN}}]});Object.assign(f.campaign,body![0]);if(mode==='scope')f.campaign.ad_account_id='1';if(mode==='status')f.campaign.status='ACTIVE';if(mode==='mode')f.campaign.is_flexible_daily_budgets=false;if(mode==='amount')f.campaign.daily_spend_cap=111_000_000;if(mode==='preserved')f.campaign.native_future_setting=false;return Response.json({items:[{data:f.campaign}]});}if(submitted&&mode==='readback-denied'&&url.pathname.endsWith('/'+CB_CAMPAIGN))return Response.json({message:CB_PRIVATE},{status:403});};try{await f.provider.applyWrite(op(args),guard);expect.fail('Expected unconfirmed outcome');}catch(error){expect(error).toMatchObject({details:{resource_ids:expect.arrayContaining([CB_CAMPAIGN])}});absent(error);}expect(f.writes()).toHaveLength(1);
  });
  it('retains safe native error codes without private bodies on rejected budget requests',async()=>{
    const f=campaignBudgetFixture(),args=await f.args();f.state.hook=({init})=>init.method==='PATCH'?Response.json({code:186,message:CB_PRIVATE},{status:400}):undefined;try{await f.provider.applyWrite(op(args),guard);expect.fail('Expected native rejection');}catch(error){expect(error).toMatchObject({details:{http_status:400,api_code:186,resource_ids:[CB_CAMPAIGN]}});absent(error);}expect(f.writes()).toHaveLength(1);
  });
});

describe('Pinterest average daily creation and shared policy',()=>{
  it('creates exactly one native CBO average campaign with reported paused coercion and independent readback',async()=>{
    const f=campaignBudgetFixture(),operation=op({...f.create,status:'ACTIVE'},'pinterest_create_campaign','create'),preview=await f.provider.previewWrite(operation,guard);expect(f.writes()).toHaveLength(0);expect(preview.coercions).toEqual(['status coerced to PAUSED by policy (paused_creation)']);expect(preview.budgetDeltas).toEqual([{target:'new campaign configured average DAILY budget',toMicros:5_000_000,currency:'EUR'}]);const result=await f.provider.applyWrite(operation,guard);expect(f.writes()[0]!.body).toEqual([{name:'QA average daily',objective_type:'CONSIDERATION',status:'PAUSED',daily_spend_cap:5_000_000,is_campaign_budget_optimization:true,is_flexible_daily_budgets:true}]);expect(result).toMatchObject({resourceIds:[CB_CREATED],details:{configuration_readback:'VERIFIED',status:'PAUSED',budget_mode:'AVERAGE',configured_daily_average_micros:5_000_000,daily_delivery_ceiling_verified:false,full_performance_plus_configuration:false}});absent(result);
  });
  it('keeps fixed creation as the default and rejects unsupported or unacknowledged average semantics',()=>{
    const f=campaignBudgetFixture();expect(createCampaignSchema.parse({name:'Fixed',objective_type:'CONSIDERATION',budget_micros:1})).toHaveProperty('daily_budget_mode','FIXED');expect(createCampaignSchema.safeParse({...f.create,acknowledge_variable_daily_spend:undefined}).success).toBe(false);expect(createCampaignSchema.safeParse({...f.create,budget_type:'LIFETIME',end_time:1893456000}).success).toBe(false);expect(createCampaignSchema.safeParse({...f.create,budget_micros:Number.MAX_SAFE_INTEGER+1}).success).toBe(false);
  });
  it.each(['absolute','relative','protected'])('enforces the existing %s policy on configured average micros',async mode=>{
    const f=campaignBudgetFixture(),dir=await mkdtemp(join(tmpdir(),'pinterest-budget-cap-'));dirs.push(dir);const policy={...DEFAULT_POLICY,...(mode==='absolute'?{max_daily_budget_micros:105_000_000}:mode==='relative'?{max_budget_delta_pct:5}:{protected_accounts:[CB_ACCOUNT]})},runtime=await createContext({engine:new PolicyEngine(policy,new PendingStore(join(dir,'pending')),new AuditLog(join(dir,'audit'))),providerModules:[{provider:f.provider,tools:pinterestTools(f.provider)}]});await expect(runtime.registry.call(tool,{account_id:CB_ACCOUNT,...await f.args()},runtime.ctx)).rejects.toMatchObject({code:'POLICY_VIOLATION'});expect(f.writes()).toHaveLength(0);
  });
  it('binds exact arguments and consumes an approval once; averaging acknowledges no fixed125percent promise',async()=>{
    const f=campaignBudgetFixture(),dir=await mkdtemp(join(tmpdir(),'pinterest-budget-approval-'));dirs.push(dir);const runtime=await createContext({engine:new PolicyEngine(DEFAULT_POLICY,new PendingStore(join(dir,'pending')),new AuditLog(join(dir,'audit'))),providerModules:[{provider:f.provider,tools:pinterestTools(f.provider)}]}),args={account_id:CB_ACCOUNT,...await f.args()},preview=await runtime.registry.call(tool,args,runtime.ctx) as Row;expect(preview.preview.notes.join(' ')).toContain('not a guaranteed daily maximum');await expect(runtime.registry.call(tool,{...args,budget_micros:109_000_000,pending_operation_id:preview.pending_operation_id},runtime.ctx)).rejects.toThrow();await runtime.registry.call(tool,{...args,pending_operation_id:preview.pending_operation_id},runtime.ctx);await expect(runtime.registry.call(tool,{...args,pending_operation_id:preview.pending_operation_id},runtime.ctx)).rejects.toThrow();expect(f.writes()).toHaveLength(1);const audit=(await Promise.all((await readdir(join(dir,'audit'))).map(name=>readFile(join(dir,'audit',name),'utf8')))).join('');expect(audit).toContain(CB_CAMPAIGN);expect(audit).not.toContain('PRIVATE-LINK');
  });
});
