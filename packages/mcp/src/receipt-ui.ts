export const RECEIPT_UI_STYLES = String.raw`
    .receipt { margin:12px 0; min-width:0 }
    .receipt-state { margin:0 0 8px; font-size:12px; font-weight:600 }
    .receipt-counts { display:flex; flex-wrap:wrap; gap:14px; margin:8px 0 }
    .receipt-counts div { display:grid; gap:3px }
    .receipt-counts dt { color:var(--muted); font-size:11px }
    .receipt-counts dd { margin:0; font-size:15px; font-variant-numeric:tabular-nums }
    .receipt-progress { display:block; width:100%; height:5px; margin:10px 0; accent-color:var(--orange) }
    .receipt-items { display:grid; max-height:240px; overflow:auto; scrollbar-width:thin }
    .receipt-item { display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:8px 0; border-top:1px solid var(--line); font-size:11px; overflow-wrap:anywhere }
    .receipt-item p { margin:3px 0 0; color:var(--muted); line-height:1.5 }
    .receipt-item > span { flex-shrink:0; color:var(--muted) }
`;

export const RECEIPT_UI_SCRIPT = String.raw`
    function receiptInfo(input) {
      const root=object(input)?input:{},result=object(root.result)?root.result:root;
      const source=object(result.details)?result.details:result,base=object(source.native)?{...source.native,...source}:source,detail=object(base.processing_info)?{...base,...base.processing_info}:base;
      const numeric=value=>(typeof value==='number'||typeof value==='string'&&/^[0-9]+$/.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>=0;
      const definitions=[['Total',['total_count','totalCount','total','expected_event_count']],['Accepted',['accepted_count','acceptedCount','accepted']],['Reported records',['record_count']],['Processed',['processed_count','processedCount','processed']],['Succeeded',['succeeded_count','success_count','successful_count','succeeded']],['Failed',['failed_count','error_count','failed','errors_count']],['Warnings',['warning_count','warnings_count']]];
      const counts=[];
      for(const [label,keys] of definitions) {
        const source=[detail.counts,detail,root.counts,root].find(source=>object(source)&&keys.some(key=>numeric(source[key])));
        const key=source&&keys.find(key=>numeric(source[key]));if(key)counts.push({label,value:Number(source[key])});
      }
      const native=String(detail.processing_status ?? detail.media_status ?? detail.state ?? detail.status ?? root.processing_status ?? root.state ?? root.status ?? '');
      const pending=/^(ACCEPTED(?:_FOR_PROCESSING)?|QUEUED|PENDING|PROCESSING|IN_PROGRESS|UPLOADING|TRANSCODING|TRANSCODE_PENDING|TRANSCODE_IN_PROGRESS|RUNNING|STARTED)$/i.test(native) || detail.processed===false;
      const complete=!pending && /^(SUCCEEDED|SUCCESS|COMPLETED|COMPLETE|READY|PROCESSED|FINISHED|TRANSCODE_COMPLETED)$/i.test(native);
      const failed=/^(FAILED|ERROR|REJECTED|TRANSCODE_FAILED)$/i.test(native),partial=/^(PARTIAL|PARTIALLY_APPLIED|PARTIAL_SUCCESS)$/i.test(native);
      const collection=[detail.results,detail.items,detail.operation_results,root.results].find(Array.isArray) || [];
      const items=collection.filter(item=>object(item) && (item.status!==undefined || item.state!==undefined || item.error!==undefined || item.success!==undefined)).map((item,index)=>{
        const error=object(item.error)?item.error.message:typeof item.error==='string'?item.error:undefined;
        return {label:String(item.id ?? item.resource_id ?? item.resourceId ?? (item.index!==undefined?'Row '+item.index:'Item '+(index+1))),status:String(item.status ?? item.state ?? (item.success===true?'Succeeded':item.success===false?'Failed':'Unconfirmed')),message:typeof error==='string'?error:typeof item.message==='string'?item.message:''};
      });
      const diagnostics=[...arr(detail.errors).map(item=>({...item,kind:'Error'})),...arr(detail.warnings).map(item=>({...item,kind:'Warning'}))].filter(item=>object(item)&&typeof item.reason==='string').map(item=>({label:item.kind,status:numeric(item.record_count)?String(item.record_count)+' records':'',message:item.reason}));
      items.push(...diagnostics);
      const percent=numeric(detail.progress_percent)&&Number(detail.progress_percent)<=100?Number(detail.progress_percent):undefined;
      const state=failed?'Failed':partial?'Partially completed':pending?'Processing pending':complete?'Completed':native&&!/^(applied|pending_validation)$/i.test(native)?human(native):'';
      return {counts,items,state,native,percent,pending:pending&&!failed&&!partial,complete,exists:counts.some(item=>item.label!=='Total') || items.length>0 || pending || failed || partial || complete || /^(UNKNOWN|REQUEST_STATUS_UNKNOWN)$/i.test(native)&&typeof detail.request_id==='string'};
    }
    function receiptMarkup(input,showState=true) {
      const receipt=receiptInfo(input);if(!receipt.exists)return '';
      const total=receipt.counts.find(item=>item.label==='Total')?.value,processed=receipt.counts.find(item=>item.label==='Processed')?.value;
      const progress=typeof total==='number'&&total>0&&typeof processed==='number'&&processed<=total?'<progress class="receipt-progress" max="'+total+'" value="'+processed+'" aria-label="Reported processed items"></progress>':typeof receipt.percent==='number'?'<p class="operation-note">'+receipt.percent+'% processed</p><progress class="receipt-progress" max="100" value="'+receipt.percent+'" aria-label="Provider-reported progress"></progress>':'';
      return '<section class="receipt" aria-label="Operation receipt">'+(showState&&receipt.state?'<p class="receipt-state" role="status">'+esc(receipt.state)+'</p>':'')+(receipt.counts.length?'<dl class="receipt-counts">'+receipt.counts.map(item=>'<div><dt>'+esc(item.label)+'</dt><dd>'+esc(item.value)+'</dd></div>').join('')+'</dl>':'')+progress+(showState&&receipt.pending?'<p class="operation-note">Accepted work is not confirmed as processed.</p>':'')+(receipt.items.length?'<div class="receipt-items" role="region" aria-label="Individual results" tabindex="0">'+receipt.items.map(item=>'<div class="receipt-item"><div>'+esc(item.label)+(item.message?'<p>'+esc(item.message)+'</p>':'')+'</div><span>'+esc(item.status)+'</span></div>').join('')+'</div>':'')+'</section>';
    }
    function renderReceipt(data,meta) {
      const value=data.value ?? data.data ?? data;
      app.innerHTML=chrome(operationHeader(human(String(meta.tool||'Processing status').replace(/^[a-z]+_/,'').replaceAll('_',' ')),meta.accountId,meta.provider)+notices({...data,errors:arr(data.errors).filter(item=>typeof item==='string'||typeof item?.message==='string'),warnings:arr(data.warnings).filter(item=>typeof item==='string'||typeof item?.message==='string')})+(receiptMarkup(value)||'<p class="operation-note">No processing outcome was reported.</p>')+'<details><summary>Details</summary><pre>'+esc(JSON.stringify(value,null,2))+'</pre></details>','');
    }
`;
