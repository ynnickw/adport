export const RECORD_UI_STYLES = String.raw`
    .record-list { display:grid; max-height:400px; overflow:auto; scrollbar-width:thin }
    .record-row { min-width:0; padding:10px 0; border-bottom:1px solid var(--line) }
    .record-heading { display:flex; align-items:baseline; justify-content:space-between; gap:10px; min-width:0 }
    .record-heading strong { font-size:12px; line-height:1.5; overflow-wrap:anywhere }
    .record-heading > span { color:var(--muted); font-size:10px; white-space:nowrap }
    .record-fields { display:flex; flex-wrap:wrap; gap:5px 16px; margin:6px 0 0; font-size:11px; line-height:1.5 }
    .record-fields > div { min-width:0; overflow-wrap:anywhere }
    .record-fields dt { display:inline; color:var(--muted); margin-right:5px }
    .record-fields dd { display:inline; margin:0 }
    .record-notes { max-height:140px; overflow:auto; scrollbar-width:thin }
`;

export const RECORD_UI_SCRIPT = String.raw`
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
      const name=fields.find(field=>/^(name|title|value|keyword|keyword text|campaign name|audience name)$/i.test(field.label));
      const id=fields.find(field=>/^(id|resource name)$/i.test(field.label));
      const status=fields.find(field=>/^(status|state|delivery status|archived)$/i.test(field.label));
      const currency=currencyOf(value)||(/^[A-Z]{3}$/.test(value.currency_code||'')?value.currency_code:currencyOf(meta));
      const chosen=fields.filter(field=>!/^note$|^notes$|^actions$|preview url|preview cover url/i.test(field.label)&&field!==name&&field!==status&&!/^(id|account id|provider|resource name|currency|currency code)$/i.test(field.label));
      chosen.sort((a,b)=>{const priority=field=>/match type|scope|budget|bid|size|type|rule|frequency/i.test(field.label)?0:1;return priority(a)-priority(b);});
      const label=name?.after ?? id?.after ?? 'Record '+(index+1);
      return '<article class="record-row"><div class="record-heading"><strong>'+esc(label)+'</strong>'+(status?'<span>'+esc(status.label==='Archived'&&typeof status.after==='boolean'?(status.after?'Archived':'Unarchived'):status.after)+'</span>':'')+'</div>'+(chosen.length?'<dl class="record-fields">'+chosen.slice(0,4).map(field=>'<div><dt>'+esc(/micros$|cents$/i.test(field.label)?field.label.replace(/ (?:micros|cents)$/i,'')+' · '+(currency||'account units'):field.label)+'</dt><dd>'+recordValue(field.after,field.label.replaceAll(' ','_'),currency)+'</dd></div>').join('')+'</dl>':'')+'</article>';
    }
    function renderRecords(data,meta) {
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
