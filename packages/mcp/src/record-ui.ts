import { RECORD_COLLECTION_STYLES, RECORD_COLLECTION_UI } from './record-collection-ui.js';

export const RECORD_UI_STYLES = String.raw`
${RECORD_COLLECTION_STYLES}
    .record-list { display:grid; max-height:400px; overflow:auto; scrollbar-width:thin }
    .record-row { min-width:0; padding:10px 0; border-bottom:1px solid var(--line) }
    .record-heading { display:flex; align-items:baseline; justify-content:space-between; gap:10px; min-width:0 }
    .record-heading strong { font-size:12px; line-height:1.5; overflow-wrap:anywhere }
    .record-heading > span { color:var(--muted); font-size:10px; white-space:nowrap }
    .record-name { display:flex; align-items:center; gap:8px; min-width:0 }
    .record-name .logo { width:23px; height:23px; padding:4px; border-radius:6px }
    .record-fields { display:flex; flex-wrap:wrap; gap:5px 16px; margin:6px 0 0; font-size:11px; line-height:1.5 }
    .record-fields > div { min-width:0; overflow-wrap:anywhere }
    .record-fields dt { display:inline; color:var(--muted); margin-right:5px }
    .record-fields dd { display:inline; margin:0 }
    .record-notes { max-height:140px; overflow:auto; scrollbar-width:thin }
    .record-providers { display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-width:0 }
    .record-provider { display:inline-flex }
    .record-provider .logo { width:26px; height:26px; padding:5px; border-radius:7px }
    .record-provider-name { color:var(--muted); font-size:11px; overflow-wrap:anywhere }
    .project-row { display:grid; grid-template-columns:34px minmax(0,1fr); gap:7px 10px; padding:12px 0; border-bottom:1px solid var(--line) }
    .project-logo { display:grid; place-items:center; width:34px; height:34px; border:1px solid var(--line); border-radius:9px; background:var(--paper); color:var(--muted); font-size:14px; font-weight:600; overflow:hidden }
    .project-logo img { display:block; width:100%; height:100%; object-fit:contain }
    .project-copy { align-self:center; min-width:0 }
    .project-copy strong { font-size:12px; line-height:1.5; overflow-wrap:anywhere }
    .project-copy p { margin:3px 0 0; color:var(--muted); font-size:11px; line-height:1.5; overflow-wrap:anywhere }
    .project-platforms-empty { margin:0; color:var(--muted); font-size:11px }
    .project-row .record-providers { grid-column:2 }
    @media(min-width:600px) {
      .project-row { grid-template-columns:34px minmax(0,1fr) minmax(0,50%) }
      .project-row .record-providers { grid-column:3; grid-row:1; justify-content:flex-end; align-self:center }
    }
`;

export const RECORD_UI_SCRIPT = String.raw`
${RECORD_COLLECTION_UI}
    let recordPages=null;
    function recordPagesIgnoreEcho(data) {
      return !!recordPages?.busy && data?._adport?.view===recordPages.meta.view && galleryMatches(data._adport,recordPages.meta) && galleryScope(data._adport)===recordPages.scope;
    }
    function providerMarks(values,meta,label='Platforms') {
      const providers=[...new Set(arr(values).filter(value=>typeof value==='string'&&value))];
      return providers.length?'<div class="record-providers" role="group" aria-label="'+esc(label)+'">'+providers.map(provider=>{
        const name=providerName(provider,meta.providerNames||{});
        return providerSvg[provider]?'<span class="record-provider" role="img" aria-label="'+esc(name)+'" title="'+esc(name)+'">'+logo(provider)+'</span>':'<span class="record-provider-name">'+esc(name)+'</span>';
      }).join('')+'</div>':'';
    }
    function renderProjects(data,meta) {
      const projects=arr(data.projects),rows=projects.slice(0,1000).map(project=>{
        const name=String(project.name||'Untitled project'),initial=[...name.trim()][0]?.toUpperCase()||'?';
        const organization=typeof project.organization_name==='string'&&project.organization_name.trim().toLowerCase()!==name.trim().toLowerCase()?project.organization_name:'';
        const subtitle=[organization,project.role?human(String(project.role)):null].filter(Boolean).join(' · ');
        let url;try { const value=new URL(project.logo_url);if(value.protocol==='https:'&&!value.username&&!value.password)url=value.href; }catch {}
        return '<article class="project-row"><span class="project-logo" aria-hidden="true" data-project-initial="'+esc(initial)+'">'+(url?'<img src="'+esc(url)+'" alt="" referrerpolicy="no-referrer">':esc(initial))+'</span><div class="project-copy"><strong>'+esc(name)+'</strong>'+(subtitle?'<p>'+esc(subtitle)+'</p>':'')+'</div>'+(providerMarks(project.providers,meta,'Connected platforms')||'<p class="record-providers project-platforms-empty">No connected platforms</p>')+'</article>';
      }).join('');
      const clean={...data};delete clean._adport;
      app.innerHTML=chrome(operationHeader('Projects','')+notices(data)+(projects.length?'<div class="record-list" role="region" aria-label="Authorized projects" tabindex="0">'+rows+'</div>':'<p class="operation-note">No accessible projects were returned.</p>')+(projects.length>1000?'<p class="operation-note">Showing 1,000 of '+projects.length+' projects. The full response is in Details.</p>':'')+'<details><summary>Details</summary><pre>'+esc(JSON.stringify(clean,null,2))+'</pre></details>',projects.length+' project'+(projects.length===1?'':'s'));
      app.querySelectorAll('.project-logo img').forEach(image=>image.addEventListener('error',()=>{const parent=image.parentElement;parent.textContent=parent.dataset.projectInitial;},{once:true}));
    }
    function recordPayload(data) {
      if(object(data)&&Array.isArray(data.records))return {records:data.records};
      const value=data.value ?? data.data ?? data.result ?? data;
      if(!object(value))return value;
      for(const key of ['keyword','audience','pixel','capi_integration','mobile_app','dataset','board','campaign','ad_group','ad','asset','customer_list'])if(object(value[key]))return value[key];
      return value;
    }
    function recordEntries(payload) {
      if(Array.isArray(payload))return payload;
      if(!object(payload))return null;
      if(['name','value','title','id','saved_audience_name','saved_audience_id','pixel_name','pixel_id','capi_connection_id'].some(key=>Object.hasOwn(payload,key)&&!object(payload[key])&&!Array.isArray(payload[key])))return null;
      const ignored=/^(_adport|notes|warnings|errors|actions|creatives|fields|media|resourceIds|resource_ids)$/;
      const keys=['items','results','records','rows','campaigns','ad_groups','ad_sets','ads','keywords','audiences','accounts','projects','assets','data'];
      const key=keys.find(key=>Array.isArray(payload[key])) ?? Object.keys(payload).find(key=>!ignored.test(key)&&Array.isArray(payload[key]));
      return key?payload[key]:null;
    }
    function recordAmountScale(path) {
      const leaf=recordLeaf(path), label=/^(micros|cents)$/.test(leaf)?recordLabel(path).toLowerCase():leaf;
      if(!/\b(?:budget|amount|price|cost|bid|spend|revenue|fee)\b/.test(label))return 0;
      return /\bmicros$/.test(leaf)?6:/\bcents$/.test(leaf)?2:0;
    }
    function recordCurrencyField(path) { return /^(?:currency|currency code)$/.test(recordLeaf(path)); }
    function recordCurrency(values,meta) {
      const codes=new Set(values.filter(value=>typeof value==='string'&&/^[A-Z]{3}$/.test(value)));
      if(!codes.size)return currencyOf(meta);
      return codes.size===1?[...codes][0]:null;
    }
    function recordValue(value,key,currency,scale=recordAmountScale(key)) {
      if(scale) {
        const amount=nativeReportDecimal(value,scale);
        if(amount!==null)return esc(currency?new Intl.NumberFormat(state.host.locale||'en',{style:'currency',currency,maximumFractionDigits:6}).format(amount):amount+' account units');
      }
      return valueHTML(value,true);
    }
    function recordRow(value,index,meta) {
      if(!object(value))return '<article class="record-row">'+valueHTML(value,true)+'</article>';
      const fields=recordVisibleFields(value);
      const identities=fields.filter(field=>(typeof field.after==='string'&&field.after.trim())||typeof field.after==='number')
        .sort((a,b)=>recordFieldPriority(a.path)-recordFieldPriority(b.path));
      const name=identities.find(field=>recordFieldPriority(field.path)<=recordRank.code && recordLeaf(field.path)!=='currency code');
      const id=identities.find(field=>recordFieldPriority(field.path)>=recordRank.id);
      const status=fields.find(field=>/^(status|state|delivery status|archived)$/.test(recordLeaf(field.path)));
      const currency=recordCurrency(fields.filter(field=>recordCurrencyField(field.path)).map(field=>field.after),meta);
      const chosen=fields.filter(field=>field!==(name||id)&&field!==status&&!/^(id|saved audience id|pixel id|capi connection id|account id|provider|resource name|currency|currency code)$/.test(recordLeaf(field.path)));
      chosen.sort((a,b)=>{const priority=field=>/match type|scope|budget|bid|size|type|rule|frequency/i.test(field.label)?0:1;return priority(a)-priority(b);});
      const displayed=chosen.slice(0,4), labels=recordColumnLabels(displayed.map(field=>field.path));
      const label=name?.after ?? id?.after ?? (displayed.length?null:'Record '+(index+1));
      const nativeProvider=typeof value.provider==='string'?value.provider:typeof value.platform==='string'&&providerSvg[value.platform]?value.platform:undefined;
      const provider=nativeProvider!==meta.provider?nativeProvider:undefined;
      const heading=label!=null||provider||status?'<div class="record-heading"><div class="record-name">'+(provider?'<span role="img" aria-label="'+esc(providerName(provider,meta.providerNames||{}))+'">'+logo(provider)+'</span>':'')+(label!=null?'<strong>'+esc(label)+'</strong>':'')+'</div>'+(status?'<span>'+esc(recordLeaf(status.path)==='archived'&&typeof status.after==='boolean'?(status.after?'Archived':'Unarchived'):status.after)+'</span>':'')+'</div>':'';
      return '<article class="record-row">'+heading+(displayed.length?'<dl class="record-fields">'+displayed.map(field=>{
        if(/^(providers|platforms)$/i.test(field.label)&&Array.isArray(field.after))return '<div><dd>'+providerMarks(field.after,meta)+'</dd></div>';
        const label=labels.get(field.path);
        return '<div><dt>'+esc(recordAmountScale(field.path)?label.replace(/ (?:micros|cents)$/i,''):label)+'</dt><dd>'+recordValue(field.after,field.path,currency)+'</dd></div>';
      }).join('')+'</dl>':'')+'</article>';
    }
    function entityRecordTable(tool) {
      return /^(?:google|meta|apple|microsoft|tiktok|linkedin|pinterest|reddit|snapchat|spotify|openai|x)_(?:list_)?(?:campaigns|campaign_groups|adgroups|ad_groups|ad_sets|adsets|line_items|adsquads)$/.test(tool||'');
    }

    function entityFields(row,meta) {
      const item=object(row?.campaign)?row.campaign:object(row?.ad_group)?row.ad_group:row||{};
      const name=item.name??item.Name??item.campaign_name??item.adgroup_name??item.id??item.Id;
      const status=item.effective_status??item.status??item.Status??item.delivery_status??item.configured_status??
        item.displayStatus??item.systemStatus??item.secondary_status??item.operation_status??item.entity_status;
      const scope=/(?:campaigns|campaign_groups)$/.test(meta.tool)?item.account_id??item.ad_account_id??item.advertiser_id??meta.accountId:
        item.campaign_name??item.campaign_id??item.campaignId??item.CampaignId??item.parent_id??meta.accountId;
      const native=item.dailyBudget??item.DailyBudget??item.daily_budget??(meta.provider==='tiktok'?item.budget:undefined);
      const daily=object(native?.value)?native.value:native;
      const minor=meta.provider==='meta'?2:0;
      const currency=currencyOf(item)||currencyOf({currency:item.currency_code??item.currencyCode??meta.currency});
      const moneyField=(value,scale)=> {
        const amount=nativeReportDecimal(object(value)?value.amount??value.Amount??value.value:value,scale);
        return amount===null?null:amount+' '+(currencyOf(object(value)?value:{})||currency||'account units');
      };
      const dailyMicros=item.daily_budget_micros??item.daily_budget_amount_local_micro??item.daily_spend_cap??item.budget?.daily_spend_limit_micros;
      const totalMicros=item.lifetime_budget_micros??item.total_budget_amount_local_micro??item.lifetime_spend_cap??item.budget?.lifetime_spend_limit_micros;
      const value=moneyField(dailyMicros,6)??moneyField(daily,minor)??moneyField(totalMicros,6)??moneyField(item.lifetime_budget,minor)??
        moneyField(item.bid_micros??item.bid_amount_local_micro,6)??moneyField(item.bidAmount??item.bid??item.bid_amount,minor);
      return [name,workflowLabel(status),scope,value];
    }

    const entityHeaders=['Name','Status','Scope','Budget or bid'];
    function recordEntryMarkup(row,index,meta,table) {
      if(!table)return recordRow(row,index,meta);
      return '<tr role="row">'+entityFields(row,meta).map((value,i)=>
        workflowCell(entityHeaders[i],esc(workflowText(value)||(i===0?'Record '+(index+1):'—')),i===0)).join('')+'</tr>';
    }

    function renderRecordPages(message='') {
      const pages=recordPages,area=app.querySelector('[data-record-pages]');if(!pages||!area)return;
      const next=pages.rows.length<1000 && galleryNext(pages.meta);
      let status=area.querySelector('[role="status"]');if(!status){status=document.createElement('p');status.className='operation-note';status.setAttribute('role','status');area.prepend(status);}status.textContent=message;status.hidden=!message;
      let button=area.querySelector('[data-record-more]');
      if(next){if(!button){button=document.createElement('button');button.type='button';button.className='media-button';button.dataset.recordMore='';button.addEventListener('click',loadRecordPage);area.append(button);}button.textContent=pages.busy?'Loading…':'Load more';button.setAttribute('aria-disabled',String(!!pages.busy));}
      else if(button){const focused=button===document.activeElement;button.remove();if(focused)(app.querySelector('[data-record-list]')?.closest('[role=region]'))?.focus({preventScroll:true});}
    }
    async function loadRecordPage() {
      const pages=recordPages,args=pages && galleryNext(pages.meta);if(!pages||pages.busy||!args||pages.rows.length>=1000)return;
      const key=galleryStable(args);if(pages.seen.has(key)){pages.meta={...pages.meta,next:undefined};renderRecordPages('No new page was returned.');return;}
      pages.busy=true;state.hasLocalResult=true;renderRecordPages();
      try {
        const response=await callTool(pages.meta.tool,args,60000),value=resultData(response),meta=value?._adport,rows=recordEntries(recordPayload(value));
        hostResults.add(JSON.stringify(value));if(hostResults.size>16)hostResults.delete(hostResults.values().next().value);
        if(recordPages!==pages){state.hasLocalResult=true;return;}
        if(response?.isError||value?.error||!Array.isArray(rows)||!meta||meta.view!==pages.meta.view||!galleryMatches(meta,pages.meta)||galleryScope(meta)!==pages.scope||!object(meta.refresh?.arguments)||galleryStable(meta.refresh.arguments)!==key||!rows.length&&(value.truncated!==false||galleryNext(meta)))throw new Error('The next page could not be confirmed.');
        const root=app.querySelector('[data-record-list]');if(!root)return;
        const displayMeta=currencyOf(value)?{...meta,currency:currencyOf(value)}:meta;
        let added=0;
        rows.forEach((row,index)=>{
          const identity=object(row)&&(typeof row.id==='string'&&row.id||typeof row.id==='number'&&Number.isSafeInteger(row.id))?'id:'+String(row.id):key+':'+index;
          const previous=pages.items.get(identity);
          if(previous){if(galleryStable(previous.row)!==galleryStable(row)){const template=document.createElement('template');template.innerHTML=recordEntryMarkup(row,previous.index,displayMeta,pages.table);const node=template.content.firstElementChild;previous.node.replaceWith(node);previous.node=node;previous.row=row;pages.rows[previous.index]=row;}return;}
          if(pages.rows.length>=1000)return;
          const template=document.createElement('template');template.innerHTML=recordEntryMarkup(row,pages.rows.length,displayMeta,pages.table);const node=template.content.firstElementChild;
          pages.items.set(identity,{row,index:pages.rows.length,node});pages.rows.push(row);root.append(node);added++;
        });
        pages.seen.add(key);pages.meta={...meta,...(!added||pages.rows.length>=1000?{next:undefined}:{})};pages.data=value;
        state.hasLocalResult=true;state.result={structuredContent:{...value,records:pages.rows.slice(),_adport:pages.meta}};
        const notes=app.querySelector('.record-notes');if(notes)notes.innerHTML=notices(value);
        const details=app.querySelector('[data-record-details]');if(details){details.querySelector('summary').textContent='Details · '+pages.rows.length+' loaded';details.querySelector('pre').textContent=JSON.stringify({loaded_records:pages.rows,latest_page:Object.fromEntries(Object.entries(value).filter(([field])=>field!=='_adport'))},null,2);}
        pages.busy=false;renderRecordPages(pages.rows.length>=1000?'Showing 1,000 records. Ask your assistant if you need more results.':!added&&rows.length?'No new records were returned. Ask your assistant for a fresh view.':'');
      }catch(error){if(recordPages===pages){pages.busy=false;renderRecordPages(error?.message||'Could not load more records.');}}
    }
    function renderRecords(data,meta) {
      if(meta.tool==='projects_list')return renderProjects(data,meta);
      if(meta.tool==='apple_report')return renderAppleReport(data,meta);
      if(nativeReportTools.has(meta.tool)&&(meta.tool!=='google_gaql'||arr(recordPayload(data)?.rows).some(row=>object(row?.metrics)&&Object.keys(row.metrics).length)))return renderNativeReport(data,meta);
      const payload=recordPayload(data),entries=recordEntries(payload),rows=entries ?? [payload];
      const title=meta.tool==='google_gaql'?'Google Ads query results':human(String(meta.tool||'Results').replace(/^(?:google|meta|tiktok|apple|microsoft|reddit|snapchat|spotify|pinterest|linkedin|openai|x)_/,'').replace(/^(?:list|get)_/,'').replace(/_(?:list|get)$/,'').replaceAll('_',' '));
      const parent=object(data.parent)?Object.entries(data.parent).filter(([key])=>/_id$/.test(key)).map(([key,value])=>human(key.replace(/_id$/,''))+' '+value).join(' · '):'';
      const scope=[parent,typeof data.parent_id==='string'&&!parent?data.parent_id:'',meta.accountId].filter(Boolean).join(' · ');
      const clean=object(data)?Object.fromEntries(Object.entries(data).filter(([key])=>key!=='_adport'&&!(key==='creatives'&&meta.view==='records'))):data;
      const table=Array.isArray(entries)&&entityRecordTable(meta.tool)&&rows.every(object);
      const displayMeta=currencyOf(data)?{...meta,currency:currencyOf(data)}:meta;
      const shown=rows.slice(0,1000);
      const collection=entries&&!table&&recordCollection(shown,meta,rows.length);
      if(collection)return renderRecordCollection(data,displayMeta,collection,title,scope,clean,rows.length);
      const markup=shown.map((row,index)=>recordEntryMarkup(row,index,displayMeta,table)).join('');
      const content=rows.length?table?'<div class="workflow-scroll" role="region" aria-label="Returned records" tabindex="0"><table class="workflow-table workflow-stack" role="table">'+workflowHeader(entityHeaders)+
        '<tbody data-record-list role="rowgroup">'+markup+'</tbody></table></div>':
        '<div class="record-list" data-record-list role="region" aria-label="Returned records" tabindex="0">'+markup+'</div>':'<p class="operation-note">No results returned.</p>';
      app.innerHTML=chrome(operationHeader(title,scope,meta.provider)+'<div class="record-notes">'+notices(data)+'</div>'+content+(rows.length>1000?'<p class="operation-note">Showing 1,000 of '+rows.length+' records. The full response is in Details.</p>':'')+'<div data-record-pages></div><details data-record-details><summary>Details'+(entries?' · '+entries.length+' results':'')+'</summary><pre>'+esc(JSON.stringify(clean,null,2))+'</pre></details>','');
      if(Array.isArray(entries)&&rows.length&&galleryNext(meta)){
        recordPages={scope:galleryScope(meta),meta,data,table,rows:rows.slice(0,1000),items:new Map(),seen:new Set([galleryStable(meta.refresh.arguments)]),busy:false};
        const nodes=app.querySelectorAll('[data-record-list]>*');recordPages.rows.forEach((row,index)=>{const identity=object(row)&&(typeof row.id==='string'&&row.id||typeof row.id==='number'&&Number.isSafeInteger(row.id))?'id:'+String(row.id):galleryStable(meta.refresh.arguments)+':'+index;recordPages.items.set(identity,{row,index,node:nodes[index]});});
        renderRecordPages();
      }
    }
    function renderData(data,meta) {
      const payload=recordPayload(data);
      const receipt=receiptInfo(payload),named=object(payload)&&['name','title'].some(key=>typeof payload[key]==='string');
      if(receipt.exists&&!named&&(!recordEntries(payload)||receipt.items.length&&/(status|processing|operation|diagnostic|job|receipt)/i.test(meta.tool||'')))return renderReceipt(data,meta);
      return renderRecords(data,meta);
    }
`;
