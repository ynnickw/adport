import { OPERATION_RECONCILIATION_UI } from './operation-reconciliation-ui.js';

/** Runs inside the shared, offline iframe closure. */
export const OPERATION_UI_SCRIPT = String.raw`
    const attempts = new Map(), pendingRequests = new Map();
    let cancelHold = () => {}, expiryTimer;
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    ${OPERATION_RECONCILIATION_UI}
    const human = value => String(value).replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_.]/g,' ').replace(/^./,c=>c.toUpperCase());
    function resultData(result) {
      if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
      for (const item of arr(result?.content)) {
        if (item.type === 'text') { try { const value=JSON.parse(item.text),data=object(value)?value:{value};return result._meta?.adport?{...data,_adport:result._meta.adport}:data; } catch {} }
      }
      return Array.isArray(result)?{value:result}:result || {};
    }
    function dataFields(value, prefix='', depth=0) {
      if (!object(value) || depth>8) return [];
      return Object.entries(value).filter(([key])=>!['_adport','data_source','pending_operation_id'].includes(key)).flatMap(([key,item])=>{
        const path=prefix?prefix+'.'+key:key;
        return object(item)?dataFields(item,path,depth+1):[{label:human(path),after:item}];
      });
    }
    function valueHTML(value,compact=false) {
      if (value===null || value===undefined) return '<span class="unavailable">Not set</span>';
      if (Array.isArray(value)) return value.length?'<ul class="review-list">'+value.slice(0,compact?3:undefined).map(item=>'<li>'+(object(item)?fieldsHTML(dataFields(item),compact):valueHTML(item,compact))+'</li>').join('')+'</ul>'+(compact && value.length>3?'<span class="operation-note">'+(value.length-3)+' more in Details</span>':''):'<span class="unavailable">None</span>';
      if (object(value)) return fieldsHTML(dataFields(value),compact);
      const text=typeof value==='boolean'?(value?'Yes':'No'):String(value);
      return esc(compact && text.length>400?text.slice(0,400)+'… (full value in Details)':text);
    }
    function fieldsHTML(fields,compact=false) {
      return '<dl class="review-fields">'+fields.map(field=>{
        const currency=currencyOf(field), isMoney=field.format==='money';
        const format=value=>isMoney && available(value)?esc(money(value/1e6,currency,6)):valueHTML(value,compact);
        const hasBefore=Object.hasOwn(field,'before') && field.before!==undefined;
        const changed=hasBefore && JSON.stringify(field.before)!==JSON.stringify(field.after);
        let value;
        if (changed && Array.isArray(field.before) && Array.isArray(field.after)) {
          const key=value=>JSON.stringify(value), before=new Set(field.before.map(key)),after=new Set(field.after.map(key));
          value=field.after.filter(v=>!before.has(key(v))).map(v=>'<span class="review-added">+ '+valueHTML(v)+'</span>').concat(field.before.filter(v=>!after.has(key(v))).map(v=>'<span class="review-removed">− '+valueHTML(v)+'</span>')).join(' ');
          if (!value) value=valueHTML(field.after);
        } else value=(changed?'<span class="review-before">'+format(field.before)+'</span><span class="review-arrow" aria-label="to">→</span>':'')+'<span class="review-after">'+format(field.after)+'</span>';
        return '<div class="review-field"><dt>'+esc(field.label)+(isMoney?' · '+esc(currency || 'account units'):'')+'</dt><dd'+(field.format==='text'?' class="review-copy"':isMoney?' class="review-money"':'')+'>'+value+'</dd></div>';
      }).join('')+'</dl>';
    }
    function legacyFields(preview) {
      const fields=arr(preview.budgetDeltas).map(v=>({label:v.target || 'Budget',format:'money',currency:v.currency,...(available(v.fromMicros)?{before:v.fromMicros}:{}),after:v.toMicros}));
      const explicit=arr(preview.fieldChanges);
      if(explicit.length && explicit.every(field=>object(field) && typeof field.field==='string' && typeof field.before==='string' && typeof field.after==='string')) return [...fields,...explicit.map(field=>({label:field.field,before:field.before,after:field.after}))];
      for (const change of arr(preview.changes)) {
        const text=String(change);
        if (/^!/.test(text)) continue;
        if (fields.length && /budget|amount_micros/i.test(text)) continue;
        const match=text.match(/^~\s+.*?\b(status|configured_status|bidding_strategy|delivery|bid|name|DailyBudget|value)\s*:?\s*(.*?)\s*→\s*(.+)$/i);
        if (match) { fields.push({label:human(match[1]),...(match[2].trim()?{before:match[2].trim()}:{}),after:match[3].trim()});continue; }
        const start=text.indexOf('{'),end=text.lastIndexOf('}');
        if (start>=0 && end>start) { try { fields.push(...dataFields(JSON.parse(text.slice(start,end+1))));continue; } catch {} }
        fields.push({label:/^-/.test(text)?'Remove':/^\+/.test(text)?'Create':'Change',after:text.replace(/^[+~!-]\s*/, '')});
      }
      return fields;
    }
    function operationOf(data,meta) { return meta?.tool==='recommendation_apply' && object(data.result)?data.result:data; }
    const pendingOf=result=>{const data=resultData(result);return operationOf(data,data._adport).pending_operation_id;};
    function operationHeader(title,subject,provider) {
      return '<div class="operation-heading">'+(provider?logo(provider):'')+'<div><h2>'+esc(title)+'</h2>'+(subject?'<p>'+esc(subject)+'</p>':'')+'</div></div>';
    }
    function renderOperation(raw,meta) {
      clearTimeout(expiryTimer);
      let data=operationOf(raw,meta), pending=data.pending_operation_id;
      const originalPreview=data.preview || {};
      const attempt=attempts.get(pending);
      if (attempt?.data) data=operationOf(attempt.data,attempt.data._adport || meta);
      const preview={...originalPreview,...data.preview},review=preview.review || {},fields=Array.isArray(review.fields)?review.fields.filter(field=>object(field) && typeof field.label==='string' && Object.hasOwn(field,'after') && field.after!==undefined):legacyFields(preview);
      const provider=providerSvg[review.provider]?review.provider:meta.provider || (providerSvg[String(meta.tool).split('_')[0]]?String(meta.tool).split('_')[0]:null);
      let title=review.title || human(String(meta.tool || 'Review change').replace(/^[a-z]+_/,'').replaceAll('_',' '));
      if (review.kind==='remove' && /permanent/i.test(preview.summary || '') && !/permanent/i.test(title)) title+=' permanently';
      const subject=[review.subject || String(preview.summary || '').match(/"([^"]+)"/)?.[1],review.accountId || meta.accountId].filter(Boolean).join(' · ');
      const applied=data.applied===true && data.status==='applied';
      const accepted=applied && data.result?.details?.status==='ACCEPTED_FOR_PROCESSING' && data.result?.details?.processed===false;
      const warnings=applied?arr(data.result?.warnings).filter(value=>typeof value==='string'):[];
      const partial=['partial','partially_applied'].includes(data.status);
      const expires=Date.parse(data.expires_at), expired=Number.isFinite(expires) && expires<=Date.now();
      const approval=meta.approval, bound=typeof pending==='string' && pending.length>0 && object(approval?.arguments) && typeof meta.tool==='string';
      const concrete=Array.isArray(review.fields) || arr(preview.fieldChanges).length || arr(preview.budgetDeltas).length || arr(preview.changes).some(change=>/^[+~-]\s/.test(String(change)) || /\{.+\}/.test(String(change)));
      const complete=typeof preview.summary==='string' && preview.summary.trim() && fields.length>0 && concrete;
      const canApprove=!applied && !partial && !attempt && !expired && Number.isFinite(expires) && bound && complete && data.status==='pending_validation' && data.applied===false && meta.capabilities?.can_write!==false;
      let phase=accepted?'Processing pending':applied?(warnings.length?'Applied with warnings':'Applied'):partial?'Partially applied':attempt?.phase==='applying'?'Applying…':attempt?.phase==='expired' || expired?'Expired':attempt?.phase==='blocked'?'Blocked':attempt?'Unconfirmed':canApprove?'':pending?'Review required':'Result';
      const action=canApprove?'<button class="approve" data-approve="true" aria-label="Hold for 0.9 seconds to apply; release to cancel"><span>Hold to apply</span></button>':phase==='Applying…'?'<button class="approve" disabled><span>Applying…</span></button>':'<span class="operation-status" role="status">'+esc(phase)+'</span>';
      const validation=preview.serverValidated===true?'Provider validated':preview.serverValidated===false?'Local preview; provider validation runs on apply':'Validation not reported';
      const details='<details><summary>Details</summary><div class="operation-details"><p>'+esc(validation)+'</p>'+(!applied && data.expires_at?'<p>Expires '+esc(data.expires_at)+'</p>':'')+'<p>'+esc(preview.summary || 'No change details returned.')+'</p>'+fieldsHTML(fields)+arr(preview.changes).map(v=>'<p>'+esc(v)+'</p>').join('')+(data.result?'<pre>'+esc(JSON.stringify(data.result,null,2))+'</pre>':'')+(attempt?.reconciliation?'<p>Reconciliation</p><pre>'+esc(JSON.stringify(attempt.reconciliation,null,2))+'</pre>':'')+'<p>'+esc(meta.tool || '')+'</p></div></details>';
      const notes=[...arr(review.notices),...arr(preview.notes),...arr(preview.changes).filter(v=>/^!/.test(String(v))).map(v=>String(v).replace(/^!\s*/,'')),...arr(preview.coercions),...warnings];
      const message=attempt?.message || (accepted?'Accepted for processing. Processing is not confirmed.':expired?'Request a fresh preview before applying.':partial?'Check each result before retrying.':pending && !canApprove && !applied && !attempt?'Review the tool response in chat before applying.':review.kind==='update' && fields.length && fields.every(field=>!Object.hasOwn(field,'before'))?'Previous values unavailable':'');
      const body=operationHeader(title,subject,provider)+(fields.length?fieldsHTML(fields.slice(0,6),true):'<p class="operation-note">No change details were returned.</p>')+(fields.length>6?'<p class="operation-note">'+(fields.length-6)+' more changes in Details</p>':'')+[...new Set(notes)].map(v=>'<p class="adjustment"'+(warnings.includes(v)?' role="alert"':'')+'>'+esc(v)+'</p>').join('')+receiptMarkup(data,false)+(message?'<p class="operation-note" role="status">'+esc(message)+'</p>':'')+'<div class="operation-footer">'+details+'<div class="operation-action">'+action+'</div></div>';
      app.innerHTML=chrome(body,'');
      if (canApprove) {
        const source=state.result;
        app.querySelectorAll('[data-approve]').forEach(button=>{cancelHold=bindHold(button,()=>{if(state.result===source) approve(meta.tool,approval.arguments,pending,expires);});});
        const updateExpiry=()=>{if(state.result===source && !attempts.has(pending)) {if(Date.now()>=expires) render(state.result);else expiryTimer=setTimeout(updateExpiry,Math.min(expires-Date.now()+5,2147483647));}};
        expiryTimer=setTimeout(updateExpiry,Math.min(expires-Date.now()+5,2147483647));
      }
    }
    function bindHold(button,complete) {
      let timer=null,interacted=false;
      const cancel=()=>{clearTimeout(timer);timer=null;button.classList.remove('holding');};
      const begin=event=>{
        if(button.disabled || timer!==null) return;
        if(event.type==='keydown') {if(![' ','Enter'].includes(event.key) || event.repeat) return;event.preventDefault();}
        else {if(event.button!==0) return;button.setPointerCapture?.(event.pointerId);}
        interacted=true;button.classList.add('holding');timer=setTimeout(()=>{cancel();complete();},900);
      };
      button.addEventListener('pointerdown',begin);
      button.addEventListener('keydown',event=>{if(event.key==='Escape') cancel();else begin(event);});
      button.addEventListener('pointermove',event=>{if(timer!==null && button.getBoundingClientRect) {const rect=button.getBoundingClientRect();if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom) cancel();}});
      ['pointerup','pointerleave','pointercancel','lostpointercapture','blur'].forEach(name=>button.addEventListener(name,cancel));
      button.addEventListener('keyup',event=>{if([' ','Enter','Escape'].includes(event.key)) cancel();});
      button.addEventListener('contextmenu',event=>event.preventDefault());
      // Assistive-technology activation has no physical press/release sequence.
      button.addEventListener('click',event=>{if(event.detail===0 && !interacted && !button.disabled) complete();});
      return cancel;
    }
    function errorPhase(data) {
      const code=data.code || data.error;
      if (['PENDING_EXPIRED','PENDING_NOT_FOUND','PENDING_MISMATCH'].includes(code)) return 'expired';
      if (['POLICY_VIOLATION','PLAN_LIMIT','NOT_CONNECTED','INVALID_INPUT'].includes(code)) return 'blocked';
      return 'unconfirmed';
    }
    function callHostTool(tool,args) {
      return callTool(tool,args).catch(error=>{throw new Error((error?.message || 'No confirmation arrived.')+' The write may have succeeded; check its status before retrying.');});
    }
    async function approve(tool,args,pending,expires) {
      if(attempts.has(pending) || pendingOf(state.result)!==pending) return;
      if(Date.now()>=expires) {render(state.result);return;}
      const original=resultData(state.result),originalOperation=operationOf(original,original._adport);
      attempts.set(pending,{phase:'applying'});render(state.result);
      try {
        const result=await callHostTool(tool,{...args,pending_operation_id:pending}),value=resultData(result),outcome=operationOf(value,{tool});
        if(!result || result.isError || value.error) {
          const phase=errorPhase(value),message=value.message || 'Adport could not confirm the change.';
          attempts.set(pending,{phase,message:phase==='unconfirmed' && !/before retrying/i.test(message)?message+' Check its status before retrying.':message,reconciliation:reconciliationOf(value,tool,args)});
        }
        else if(outcome.applied===true && outcome.status==='applied') {
          const preview={...originalOperation.preview,...outcome.preview};
          const data=tool==='recommendation_apply'?{...value,result:{...outcome,preview}}:{...value,preview};
          attempts.set(pending,{phase:'applied',data});
        }
        else if(['partial','partially_applied'].includes(outcome.status)) attempts.set(pending,{phase:'partial',data:value});
        else attempts.set(pending,{phase:'unconfirmed',message:'The change was not confirmed as applied. Check its status before retrying.'});
      } catch(error) {attempts.set(pending,{phase:'unconfirmed',message:error?.message || 'The change could not be confirmed. Check its status before retrying.'});}
      // A late response belongs to its original review, never a newer preview.
      const attempt=attempts.get(pending),outcome=attempt.data?operationOf(attempt.data,{tool}):null;
      if(pendingOf(state.result)===pending) {
        if(attempt.data) acceptResult({structuredContent:{...attempt.data,_adport:{...original._adport,...attempt.data._adport,approval:undefined}}},true);
        else render(state.result);
      }
      const details=outcome?.result?.details,resources=arr(outcome?.result?.resourceIds).filter(value=>typeof value==='string'),warnings=arr(outcome?.result?.warnings).filter(value=>typeof value==='string');
      const reportedCounts=receiptInfo(outcome||{}).counts;
      const reconciliation=attempt.reconciliation || (tool==='x_create_repost_promotions' && outcome?.applied===true && outcome.status==='applied'?reconciliationOf(outcome.result,tool,args,true):null);
      const facts={tool,status:attempt.phase,...(reportedCounts.length?{counts:Object.fromEntries(reportedCounts.map(item=>[item.label.toLowerCase(),item.value]))}:{}),...(typeof args.project_id==='string'?{project_id:args.project_id}:{}),...(typeof args.account_id==='string'?{account_id:args.account_id}:{}),...(outcome?{resource_ids:resources.slice(0,100),...(resources.length>100?{resource_ids_truncated:true,total_resource_ids:resources.length}:{}),...(details?.status==='ACCEPTED_FOR_PROCESSING' && details?.processed===false?{processing_status:'ACCEPTED_FOR_PROCESSING',processed:false}:{}),...(warnings.length?{warnings:warnings.slice(0,20)}:{}),...(typeof details?.next_tool==='string'?{next_tool:details.next_tool}:{}),...(typeof details?.resource_receipt==='string'?{resource_receipt:details.resource_receipt}:{})}:{message:attempt.message}),...(reconciliation?{reconciliation,...(reconciliation.resource_ids?{resource_ids:reconciliation.resource_ids}:{}),...(reconciliation.resource_ids_truncated?{resource_ids_truncated:true,total_resource_ids:reconciliation.total_resource_ids}:{})}:{})};
      if(typeof window.openai?.setWidgetState==='function') Promise.resolve().then(()=>window.openai.setWidgetState({lastOperation:facts})).catch(()=>{});
      else send({jsonrpc:'2.0',id:id++,method:'ui/update-model-context',params:{structuredContent:{adport_operation:facts}}});
    }
    function renderFailure(data,meta,isWrite) {
      const phase=errorPhase(data),title=phase==='expired'?'Preview expired':phase==='blocked'?'Action blocked':isWrite?'Outcome unconfirmed':'Request failed';
      app.innerHTML=chrome(operationHeader(title,meta.accountId,meta.provider)+'<p class="operation-note" role="alert">'+esc(data.message || (isWrite?'Check the result before retrying.':'See the tool response for details.'))+'</p>'+(!['expired','blocked'].includes(phase) && isWrite?'<p class="operation-note">Check the current state before retrying.</p>':'')+'<details><summary>Details</summary><pre>'+esc(JSON.stringify(data,null,2))+'</pre></details>','');
    }
`;
