export const RECORD_UI_STYLES = String.raw`
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
    .project-row .record-providers { grid-column:2 }
    @media(min-width:600px) {
      .project-row { grid-template-columns:34px minmax(0,1fr) minmax(0,50%) }
      .project-row .record-providers { grid-column:3; grid-row:1; justify-content:flex-end; align-self:center }
    }
`;

export const RECORD_UI_SCRIPT = String.raw`
    function providerMarks(values,meta) {
      const providers=[...new Set(arr(values).filter(value=>typeof value==='string'&&value))];
      return providers.length?'<div class="record-providers" role="group" aria-label="Connected platforms">'+providers.map(provider=>{
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
        return '<article class="project-row"><span class="project-logo" aria-hidden="true" data-project-initial="'+esc(initial)+'">'+(url?'<img src="'+esc(url)+'" alt="" referrerpolicy="no-referrer">':esc(initial))+'</span><div class="project-copy"><strong>'+esc(name)+'</strong>'+(subtitle?'<p>'+esc(subtitle)+'</p>':'')+'</div>'+providerMarks(project.providers,meta)+'</article>';
      }).join('');
      const clean={...data};delete clean._adport;
      app.innerHTML=chrome(operationHeader('Projects','')+notices(data)+(projects.length?'<div class="record-list" role="region" aria-label="Authorized projects" tabindex="0">'+rows+'</div>':'<p class="operation-note">No accessible projects were returned.</p>')+'<details><summary>Details</summary><pre>'+esc(JSON.stringify(clean,null,2))+'</pre></details>',projects.length+' project'+(projects.length===1?'':'s'));
      app.querySelectorAll('.project-logo img').forEach(image=>image.addEventListener('error',()=>{const parent=image.parentElement;parent.textContent=parent.dataset.projectInitial;},{once:true}));
    }
    function recordPayload(data) {
      const value=data.value ?? data.data ?? data.result ?? data;
      if(!object(value))return value;
      for(const key of ['keyword','audience','board','campaign','ad_group','ad','asset','customer_list'])if(object(value[key]))return value[key];
      return value;
    }
    function recordEntries(payload) {
      if(Array.isArray(payload))return payload;
      if(!object(payload))return null;
      if(['name','value','title','id'].some(key=>Object.hasOwn(payload,key)&&!object(payload[key])&&!Array.isArray(payload[key])))return null;
      const ignored=/^(_adport|notes|warnings|errors|actions|creatives|fields|media|resourceIds|resource_ids)$/;
      const keys=['items','results','records','campaigns','ad_groups','ad_sets','ads','keywords','audiences','accounts','projects','assets','data'];
      const key=keys.find(key=>Array.isArray(payload[key])) ?? Object.keys(payload).find(key=>!ignored.test(key)&&Array.isArray(payload[key]));
      return key?payload[key]:null;
    }
    function recordValue(value,key,currency) {
      if(typeof value==='number'&&Number.isFinite(value)&&/micros$|cents$/i.test(key))return esc(money(value/(/cents$/i.test(key)?100:1e6),currency,6));
      return valueHTML(value,true);
    }
    function recordRow(value,index,meta) {
      if(!object(value))return '<article class="record-row">'+valueHTML(value,true)+'</article>';
      const fields=dataFields(value).filter(field=>!/(?:hash|token|secret|password|authorization|pending operation|snapshot)/i.test(field.label));
      const name=fields.find(field=>/^(name|display name|title|value|keyword|keyword text|campaign name|ad group name|ad name|creative name|account name|audience name)$/i.test(field.label));
      const id=fields.find(field=>/^(id|resource name)$/i.test(field.label));
      const status=fields.find(field=>/^(status|state|delivery status|archived)$/i.test(field.label));
      const currency=currencyOf(value)||(/^[A-Z]{3}$/.test(value.currency_code||'')?value.currency_code:currencyOf(meta));
      const chosen=fields.filter(field=>!/^note$|^notes$|^actions$|preview url|preview cover url|logo url/i.test(field.label)&&field!==name&&field!==status&&!/^(id|account id|provider|resource name|currency|currency code)$/i.test(field.label));
      chosen.sort((a,b)=>{const priority=field=>/match type|scope|budget|bid|size|type|rule|frequency/i.test(field.label)?0:1;return priority(a)-priority(b);});
      const label=name?.after ?? id?.after ?? 'Record '+(index+1);
      const nativeProvider=typeof value.provider==='string'?value.provider:typeof value.platform==='string'&&providerSvg[value.platform]?value.platform:undefined;
      const provider=nativeProvider!==meta.provider?nativeProvider:undefined;
      return '<article class="record-row"><div class="record-heading"><div class="record-name">'+(provider?'<span role="img" aria-label="'+esc(providerName(provider,meta.providerNames||{}))+'">'+logo(provider)+'</span>':'')+'<strong>'+esc(label)+'</strong></div>'+(status?'<span>'+esc(status.label==='Archived'&&typeof status.after==='boolean'?(status.after?'Archived':'Unarchived'):status.after)+'</span>':'')+'</div>'+(chosen.length?'<dl class="record-fields">'+chosen.slice(0,4).map(field=>/^(providers|platforms)$/i.test(field.label)&&Array.isArray(field.after)?'<div><dd>'+providerMarks(field.after,meta)+'</dd></div>':'<div><dt>'+esc(/micros$|cents$/i.test(field.label)?field.label.replace(/ (?:micros|cents)$/i,'')+' · '+(currency||'account units'):field.label)+'</dt><dd>'+recordValue(field.after,field.label.replaceAll(' ','_'),currency)+'</dd></div>').join('')+'</dl>':'')+'</article>';
    }
    function renderRecords(data,meta) {
      if(meta.tool==='projects_list')return renderProjects(data,meta);
      const payload=recordPayload(data),entries=recordEntries(payload),rows=entries ?? [payload];
      const title=human(String(meta.tool||'Results').replace(/^(?:google|meta|tiktok|apple|microsoft|reddit|snapchat|spotify|pinterest|linkedin|x)_/,'').replace(/^(?:list|get)_/,'').replace(/_(?:list|get)$/,'').replaceAll('_',' '));
      const parent=object(data.parent)?Object.entries(data.parent).filter(([key])=>/_id$/.test(key)).map(([key,value])=>human(key.replace(/_id$/,''))+' '+value).join(' · '):'';
      const scope=[parent,typeof data.parent_id==='string'&&!parent?data.parent_id:'',meta.accountId].filter(Boolean).join(' · ');
      const clean=object(data)?Object.fromEntries(Object.entries(data).filter(([key])=>key!=='_adport'&&!(key==='creatives'&&meta.view==='records'))):data;
      const content=rows.length?'<div class="record-list" role="region" aria-label="Returned records" tabindex="0">'+rows.slice(0,1000).map((row,index)=>recordRow(row,index,meta)).join('')+'</div>':'<p class="operation-note">No results returned.</p>';
      app.innerHTML=chrome(operationHeader(title,scope,meta.provider)+'<div class="record-notes">'+notices(data)+'</div>'+content+(rows.length>1000?'<p class="operation-note">Showing 1,000 of '+rows.length+' records. The full response is in Details.</p>':'')+'<details><summary>Details'+(entries?' · '+entries.length+' results':'')+'</summary><pre>'+esc(JSON.stringify(clean,null,2))+'</pre></details>','');
    }
    function renderData(data,meta) {
      const payload=recordPayload(data);
      const receipt=receiptInfo(payload),named=object(payload)&&['name','title'].some(key=>typeof payload[key]==='string');
      if(receipt.exists&&!named&&(!recordEntries(payload)||receipt.items.length&&/(status|processing|operation|diagnostic|job|receipt)/i.test(meta.tool||'')))return renderReceipt(data,meta);
      return renderRecords(data,meta);
    }
`;
