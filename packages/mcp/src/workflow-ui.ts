import { MEDIA_PREPARATION_TOOLS, MEDIA_UPLOAD_TOOLS } from '@adport/core';

export const WORKFLOW_UI_STYLES = String.raw`
    .workflow-list { display:grid; gap:0; max-height:430px; overflow:auto; scrollbar-width:thin }
    .workflow-item { min-width:0; padding:10px 0; border-bottom:1px solid var(--line); overflow-wrap:anywhere }
    .workflow-item h3 { margin:0; font-size:12px }
    .workflow-heading { display:flex; align-items:baseline; justify-content:space-between; flex-wrap:wrap; gap:8px }
    .workflow-item p { margin:5px 0 0; color:var(--muted); font-size:11px; line-height:1.55 }
    .workflow-item .record-fields { margin-top:6px }
    .workflow-item .media-button { margin-top:8px }
    .workflow-timeline { list-style:none; padding-left:12px; border-left:1px solid var(--line) }
    .workflow-arms { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr)); gap:12px }
    .workflow-scroll { overflow:auto; max-height:430px; scrollbar-width:thin; margin-top:8px }
    .workflow-table { width:100%; border-collapse:collapse; font-size:11px }
    .workflow-table th,.workflow-table td { padding:8px; border-bottom:1px solid var(--line); text-align:left; overflow-wrap:anywhere }
    .workflow-table thead th { position:sticky; top:0; z-index:1; background:var(--paper); color:var(--muted); font-weight:500 }
    .workflow-table tbody th { font-weight:600 }
    .workflow-link { color:var(--ink); text-underline-offset:2px }
    .workflow-cell-label { display:none }
    :root[data-theme="dark"] .workflow-item .pill:not(.neutral):not(.warn) { color:#70c9a1 }
    :root[data-theme="dark"] .workflow-item .pill.warn { color:#f0bb67 }
    @media (max-width:480px) {
      .workflow-stack,.workflow-stack tbody,.workflow-stack tr { display:block }
      .workflow-stack thead { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%) }
      .workflow-stack tbody tr { border-bottom:1px solid var(--line); padding:7px 0 }
      .workflow-stack tbody :is(td,th) { display:grid; grid-template-columns:minmax(88px,2fr) minmax(0,3fr); gap:8px; padding:4px 0; border:0 }
      .workflow-stack .workflow-cell-label { display:block; color:var(--muted); font-weight:400 }
      .workflow-stack .workflow-cell-label::before { content:attr(data-label) }
    }
`;

export const WORKFLOW_UI = String.raw`
    const uploadPreviewTools=new Set(${JSON.stringify([...MEDIA_UPLOAD_TOOLS])});
    const preparePreviewTools=new Set(${JSON.stringify([...MEDIA_PREPARATION_TOOLS])});
    const workflowRows=value=>arr(value).filter(object);
    const workflowText=value=>typeof value==='string'&&value.trim()?value:typeof value==='number'&&Number.isFinite(value)?String(value):'';
    const workflowLabel=value=>workflowText(value)?human(String(value).replace(/^[A-Z][A-Z0-9_]+$/,word=>word.toLowerCase())):'';
    const workflowNote=value=>workflowText(value)?'<p class="operation-note">'+esc(value)+'</p>':'';
    const workflowEmpty=value=>'<p class="empty">'+esc(value)+'</p>';
    const workflowDetails=data=>'<details><summary>Details</summary><pre>'+esc(JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key])=>key!=='_adport')),null,2))+'</pre></details>';

    function workflowFields(pairs) {
      const fields=pairs.filter(([,value])=>workflowText(value));
      return fields.length?'<dl class="record-fields">'+fields.map(([label,value])=>'<div><dt>'+esc(label)+'</dt><dd>'+esc(value)+'</dd></div>').join('')+'</dl>':'';
    }

    function workflowItem(title,status,body,tag='article',tone='neutral') {
      return '<'+tag+' class="workflow-item"><div class="workflow-heading"><h3><strong>'+esc(title)+'</strong></h3>'+
        (status?'<span class="pill '+tone+'">'+esc(status)+'</span>':'')+'</div>'+body+'</'+tag+'>';
    }

    function workflowHeader(labels,sorted=-1) {
      return '<thead role="rowgroup"><tr role="row">'+labels.map((label,i)=>
        '<th role="columnheader" scope="col"'+(i===sorted?' aria-sort="descending"':'')+'>'+esc(label)+'</th>').join('')+'</tr></thead>';
    }

    function workflowCell(label,html,heading=false) {
      const tag=heading?'th':'td',role=heading?'rowheader':'cell';
      return '<'+tag+' role="'+role+'"'+(heading?' scope="row"':'')+'>'+
        '<span class="workflow-cell-label" aria-hidden="true" data-label="'+esc(label)+'"></span><span>'+html+'</span></'+tag+'>';
    }

    function workflowTable(labels,rows,description,{compact=false,sorted=-1}={}) {
      if(!rows.length)return '';
      return '<div class="'+(compact?'collection-scroll':'workflow-scroll')+'" role="region" aria-label="'+esc(description)+'" tabindex="0">'+
        '<table class="workflow-table'+(compact?'':' workflow-stack')+'" role="table">'+workflowHeader(labels,sorted)+'<tbody role="rowgroup">'+
        rows.map(row=>'<tr role="row">'+row.map((value,i)=>workflowCell(labels[i],esc(workflowText(value)||'—'),i===0)).join('')+'</tr>').join('')+
        '</tbody></table></div>';
    }

    function workflowUrl(value) {
      try {
        const parsed=new URL(value);
        return parsed.protocol==='https:'&&!parsed.username&&!parsed.password?parsed.href:null;
      } catch {return null;}
    }

    function workflowLink(url,label,attribute='') {
      return url?'<p class="operation-note"><a class="workflow-link" '+attribute+' href="'+esc(url)+'" target="_blank" rel="noreferrer noopener">'+esc(label)+'</a></p>':'';
    }

    function workflowList(body,label) {
      return '<div class="workflow-list" role="region" aria-label="'+esc(label)+'" tabindex="0">'+body+'</div>';
    }

    function workflowDate(value) {
      if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))return null;
      return value;
    }

    function workflowMillis(value) {
      return typeof value==='number'&&Number.isFinite(new Date(value).getTime())?new Date(value).toISOString():null;
    }

    function renderAvailability(data,meta) {
      const settings=workflowUrl(data.manage_access_url);
      const access=settings&&new URL(settings).pathname==='/dashboard/agents'?settings:null;
      const tools=workflowRows(data.tools);
      const matches=typeof data.total_matches==='number'?data.total_matches:tools.length;
      const coverage=workflowRows(data.platforms).filter(platform=>platform.selected===true);
      const rows=tools.map(item=>workflowItem(item.name||'Tool',item.enabled===true?'Ready':item.enabled===false?'Blocked':'Status unavailable',
        workflowFields([['Platform',providerName(item.provider,meta.providerNames)],['Access',item.read_only===true?'Read-only':item.read_only===false?'Requires write access':null]])+
        (item.description?'<p>'+esc(item.description)+'</p>':'')+
        (item.enabled===false?'<p>'+arr(item.blockers).map(workflowLabel).filter(Boolean).map(esc).join(' · ')+'</p>'+
          arr(item.next_steps).filter(workflowText).map(step=>'<p>'+esc(step)+'</p>').join(''):''),
        'article',item.enabled===true?'':item.enabled===false?'warn':'neutral')).join('');
      const total=(data.truncated?tools.length+' of '+matches:matches)+' matching '+(matches===1?'tool':'tools');
      const platformDetails=coverage.length?'<details><summary>Selected platforms</summary>'+workflowFields(coverage.map(platform=>[providerName(platform.id,meta.providerNames),platform.connected===true?'Connected':platform.connected===false?'Connection required':'Status unavailable']))+'</details>':'';
      app.innerHTML=chrome(operationHeader('Tool availability','')+(rows?workflowList(rows,'Matching tools'):workflowEmpty('No matching tools were returned.'))+
        workflowLink(access,'Manage tool access ↗')+workflowNote(data.profile?'Connection profile · '+workflowLabel(data.profile):'')+platformDetails+workflowDetails(data),total);
    }

    function measurementTable(data,tool) {
      switch(tool) {
        case 'reddit_pixel_last_fired': {
          const pairs=Object.entries(object(data.last_fired_at)?data.last_fired_at:{});
          return workflowTable(['Event','Last received'],pairs.map(([event,time])=>[workflowLabel(event),workflowDate(time)||'Unavailable']),'Pixel event activity');
        }
        case 'pinterest_event_quality':
          return workflowList(workflowRows(data.items).map(item=>{
            const components=Object.entries(item.quality_components||{}).flatMap(([component,events])=>
              Object.entries(events||{}).map(([event,result])=>[
                workflowLabel(component)+' · '+workflowLabel(event),result?.coverage,result?.overlap,
                workflowRows(result?.issues).map(issue=>[issue.name,issue.reason].filter(workflowText).join(' · ')).filter(Boolean).join(' | ')
              ]));
            return workflowItem(workflowLabel(item.source_platform)||'Source',workflowLabel(item.overall_status),
              workflowFields([['Source',workflowLabel(item.ingestion_source)],['Lookback',item.lookback_period]])+
              workflowTable(['Component and event','Coverage','Overlap','Issues'],components,'Event quality components'));
          }).join(''),'Source diagnostics');
        case 'openai_conversion_events':
          return workflowTable(['Event','Channel','Event time','Received'],workflowRows(data.events).map(item=>[
            item.event_type ?? item.event_name,item.api_channel,workflowDate(item.event_time),workflowDate(item.received_at)
          ]),'Sampled events');
        case 'tiktok_pixel_event_stats':
          return workflowTable(['Pixel','Event','Reported count','Last activity'],workflowRows(data.list).map(item=>[
            item.pixel_name ?? item.pixel_id,item.event_name ?? item.event_type ?? item.event,
            item.event_count ?? item.count,workflowDate(item.last_event_time ?? item.last_fired_at)
          ]),'Pixel observations');
        case 'spotify_dataset_diagnostics':
          return workflowList(workflowRows(data.datasources).map(source=>workflowItem(source.datasource_id,workflowLabel(source.datasource_type),
            workflowFields([['Interval',workflowLabel(source.granularity)]])+
            workflowTable(['Interval start','Event','Count','Last activity'],workflowRows(source.timeseries).flatMap(bucket=>{
              const time=workflowMillis(bucket.timestamp);
              const events=workflowRows(bucket.event_counts);
              return events.length?events.map(event=>[time,event.name,event.event_count,workflowMillis(event.last_activity_ms)]):[[time,'All reported events',bucket.total,null]];
            }),'Reported activity')
          )).join(''),'Dataset sources');
        default:return '';
      }
    }

    function renderMeasurement(data,meta) {
      const tool=meta.tool,period=data.date_range;
      const subject=[data.pixel_id?'Pixel '+data.pixel_id:null,data.dataset_id?'Dataset '+data.dataset_id:null,
        object(period)?[period.start_date??period.start,period.end_date??period.end].filter(workflowText).join(' – '):period].filter(workflowText).join(' · ');
      let body=measurementTable(data,tool);
      if(tool==='meta_custom_conversion_stats') {
        const rows=workflowRows(data.stats).flatMap(bucket=>workflowRows(bucket.data).map(entry=>({
          date:workflowDate(bucket.timestamp),entry
        })));
        // Named, explicitly numeric metrics are charted per native series. Bucket
        // payloads remain separate even if multiple series report the same date.
        const records=rows.map(({date,entry},i)=>{
          const group=Object.entries(entry).filter(([key,value])=>typeof value==='string'&&!/^(count|value)$/i.test(key)&&reportNumber(value)===null).map(([,value])=>value).join(' · ');
          const measure=entry.count??(/^(?:count|unmatched_count|usd_amount|unmatched_usd_amount)$/.test(data.aggregation)?entry.value:null);
          const count=reportNumber(measure);
          const unit=/_usd_amount$|^usd_amount$/.test(data.aggregation)?'USD':'';
          const label=unit?'Reported amount':data.aggregation==='unmatched_count'?'Unmatched count':'Reported count';
          return {date:date?.slice(0,10),name:date||'Bucket '+(i+1),series:group||'Reported count',context:group?[group]:[],
            fields:count===null?[]:[{key:'count',label,unit,value:count,display:String(measure)}]};
        }).filter(row=>row.fields.length);
        const periods=new Set(records.map(row=>row.date).filter(Boolean));
        const chart=periods.size>1&&records.every(row=>row.date)&&
          new Set(records.map(row=>JSON.stringify([row.date,row.series]))).size===records.length?reportCharts(records,{metric:'count'}):null;
        const args=readPageArgs(meta,'data-measurement-next');
        body=(chart?.html||'')+workflowTable(['Timestamp','Native values'],workflowRows(data.stats).map(bucket=>[
          bucket.timestamp,workflowRows(bucket.data).map(entry=>Object.entries(entry).filter(([,val])=>workflowText(val)).map(([key,val])=>workflowLabel(key)+' '+val).join(' · ')).filter(Boolean).join(' | ')
        ]),'Native conversion buckets')+readPageMarkup(args,'data-measurement-next','data-measurement-status');
        app.innerHTML=chrome(operationHeader('Conversion statistics',[data.conversion_id?'Conversion '+data.conversion_id:null,workflowLabel(data.aggregation),
          [meta.refresh?.arguments?.start_time,meta.refresh?.arguments?.end_time].filter(workflowText).join(' – ')].filter(Boolean).join(' · '),meta.provider)+notices(data)+(body||workflowEmpty('No conversion statistics were returned.'))+workflowDetails(data),'');
        chart?.mount();
        bindReadPage(meta,args,'data-measurement-next','data-measurement-status',value=>Array.isArray(value.stats));
        return;
      }
      const hasRows=tool==='pinterest_event_quality'?workflowRows(data.items).length:tool==='spotify_dataset_diagnostics'?workflowRows(data.datasources).length:true;
      app.innerHTML=chrome(operationHeader('Measurement health',subject,meta.provider)+notices(data)+
        (tool==='openai_conversion_events'?workflowNote('Recent event sample. Counts cover the rows shown. (Sample size: '+arr(data.events).length+')'):'')+
        (body&&hasRows?body:workflowEmpty('No matching observations were returned.'))+workflowDetails(data),'');
    }

    function renderHistory(data,meta) {
      const args=readPageArgs(meta,'data-history-next');
      const events=workflowRows(Array.isArray(data.result)?data.result:data.events);
      const ordered=[...events].sort((a,b)=>(Date.parse(b.eventTime)||0)-(Date.parse(a.eventTime)||0));
      const rows=ordered.slice(0,1000).map(item=>workflowItem([workflowLabel(item.eventType),workflowLabel(item.entityType)].filter(Boolean).join(' · ')||'Change',null,
        workflowFields([['Time (UTC)',workflowDate(item.eventTime)],['Actor',item.modifiedBy],['Actor type',workflowLabel(item.userType)],['Transaction',item.transactionId],['Changes',item.count]])+
        (workflowRows(item.metas).length?'<details><summary>Returned entity metadata</summary><pre>'+esc(JSON.stringify(item.metas,null,2))+'</pre></details>':''),'li')).join('');
      app.innerHTML=chrome(operationHeader('Change history',meta.accountId,meta.provider)+notices(data)+(rows?'<ol class="workflow-list workflow-timeline">'+rows+'</ol>':workflowEmpty('No change summaries were returned.'))+
        (ordered.length>1000?workflowNote('Showing 1,000 changes. All returned changes are in Details.'):'' )+
        readPageMarkup(args,'data-history-next','data-history-status')+workflowDetails(data),ordered.length+' returned');
      bindReadPage(meta,args,'data-history-next','data-history-status',value=>Array.isArray(value.result));
    }

    function renderExperiment(data,meta) {
      const experiment=data.experiment,arms=workflowRows(data.arms),campaigns=workflowRows(data.campaigns),currency=currencyOf({currency:data.account?.currencyCode});
      const comparison=arms.map(arm=>{
        const linked=[...new Set([...arr(arm.campaigns),...arr(arm.inDesignCampaigns)])];
        const budgets=linked.map(resource=>{
          const value=campaigns.find(item=>item.campaign?.resourceName===resource),native=value?.budget;
          const micros=native?.period==='DAILY'?value.budget_micros:null;
          return [value?.campaign?.name||resource,workflowLabel(value?.campaign?.status),available(micros)?money(micros/1e6,currency,6):null];
        });
        return workflowItem(arm.name||'Arm',arm.control===true?'Control':arm.control===false?'Treatment':'',
          workflowFields([['Traffic',reportNumber(arm.trafficSplit)===null?null:arm.trafficSplit+'%']])+
          workflowTable(['Campaign','Status',currency?'Daily budget · '+currency:'Daily budget · account units'],budgets,'Campaigns in this arm'));
      }).join('');
      const base=data.base_campaign,daily=base?.budget?.period==='DAILY'?base.budget_micros:null;
      const content=object(experiment)?workflowFields([['Status',workflowLabel(experiment.status)],['Start',experiment.startDate],['End',experiment.endDate],['Account timezone',data.account?.timeZone]])+
        (comparison?'<div class="workflow-arms">'+comparison+'</div>':workflowEmpty('No experiment arms were returned.')):
        object(base)?workflowFields([['Base campaign',base.campaign?.name],['Status',workflowLabel(base.campaign?.status)],['Daily budget',available(daily)?money(daily/1e6,currency,6):null]]):
        workflowEmpty('No experiment or base campaign was returned.');
      app.innerHTML=chrome(operationHeader(experiment?.name||'Experiment comparison',meta.accountId,meta.provider)+notices(data)+content+workflowDetails(data),'Configuration');
    }

    function renderCatalogProcessing(data,meta) {
      const tool=meta.tool,rows=workflowRows(data.records);
      const identity=data.batch_id??data.feed_id??data.import_id??data.processing_result_id;
      let report='';
      if(tool==='reddit_catalog_import_report') {
        const expires=workflowDate(data.expires_at),href=data.report_available===true&&expires&&Date.parse(expires)>Date.now()?workflowUrl(data.download_url):null;
        report=href?workflowLink(href,'Download native report ↗','data-catalog-download')+workflowNote('Expires '+expires):workflowNote('The native report is unavailable or expired.');
      }
      const items=rows.map(item=>{
        const detail=item.message??item.error?.message??item.error??item.reason;
        const counts=Object.entries(item.product_counts??item.summary??Object.fromEntries(
          ['added','updated','removed','errors','warnings','affected_product_count','affected_video_count'].map(key=>[key,item[key]])
        )).filter(([,value])=>workflowText(value));
        const structured=['validation_details','ingestion_details','errors','warnings','issues'].filter(key=>item[key]&&Object.keys(item[key]).length);
        return workflowItem(item.name||item.source_id||item.item_id||item.id||item.code||'Result',item.status??item.severity,
          workflowFields([['Store',item.store_code],['Updated',workflowDate(item.updated_at)],['Completed',item.completed_at],
            ['Readback',workflowLabel(item.readback)],['Code',item.code],['Field',item.field],['Line',item.line],['Product',item.product_id],
            ...counts.map(([key,value])=>[workflowLabel(key),value])])+
          workflowNote(detail)+(structured.length?'<details><summary>Provider diagnostics</summary><pre>'+esc(JSON.stringify(Object.fromEntries(structured.map(key=>[key,item[key]])),null,2))+'</pre></details>':''));
      }).join('');
      const args=readPageArgs(meta,'data-catalog-next');
      const summary=receiptMarkup({status:data.status})+
        workflowFields([['Submitted',data.submitted_items],['Terminal item outcomes',data.terminal_items]]);
      app.innerHTML=chrome(operationHeader('Catalog processing',identity,meta.provider)+notices(data)+summary+
        (data.all_items_native_successful===false?workflowNote('Some item outcomes are unsuccessful or unconfirmed.'):'')+
        report+(items?workflowList(items,'Catalog outcomes'):report?'':workflowEmpty('No processing records were returned.'))+
        workflowTable(['Severity','Field','Affected items'],['error_fields','warning_fields'].flatMap(key=>
          workflowRows(data.log?.[key]).map(row=>[key==='error_fields'?'Error':'Warning',row.field,row.affected_product_count??row.affected_video_count])
        ),'Affected fields')+
        readPageMarkup(args,'data-catalog-next','data-catalog-status')+workflowDetails(data),'');
      app.querySelector('[data-catalog-download]')?.addEventListener('click',event=>{
        if(Date.parse(data.expires_at)>Date.now())return;
        event.preventDefault();
        const message=document.createElement('span');
        message.setAttribute('role','status');
        message.textContent='This report link expired. Request a fresh report.';
        event.currentTarget.replaceWith(message);
      });
      bindReadPage(meta,args,'data-catalog-next','data-catalog-status',value=>Array.isArray(value.records));
    }

    function distributionArguments(item,data,meta) {
      const tools=item.stage==='upload'?uploadPreviewTools:item.stage==='prepare'?preparePreviewTools:null;
      if(meta.capabilities?.can_write!==true||!meta.context?.project_id||item.ready!==true||item.available!==true||
        !tools?.has(item.tool)||typeof item.provider!=='string'||!item.tool.startsWith(item.provider+'_')||
        typeof item.account_id!=='string'||!object(item.arguments)) return null;
      const args=item.arguments;
      if(args.account_id!==item.account_id||Object.hasOwn(args,'project_id')&&args.project_id!==meta.context.project_id||
        Object.hasOwn(args,'pending_operation_id')||Object.hasOwn(args,'file_path')) return null;
      if(item.stage==='upload'&&(!data.asset?.id||!data.asset?.sha256||args.media_id!==data.asset.id||args.expected_sha256!==data.asset.sha256))return null;
      return {...args,project_id:meta.context.project_id};
    }

    let distributionReview=null;
    function distributionIgnoreEcho(data) {
      const pending=distributionReview,actual=data?._adport;
      return !!pending&&actual?.tool===pending.item.tool&&actual.context?.project_id===pending.args.project_id&&
        actual.accountId===pending.args.account_id&&samePreviewArguments(actual.approval?.arguments,pending.args);
    }

    function renderDistribution(data,meta) {
      const plan=meta.tool==='media_distribution_plan',items=workflowRows(plan?data.destinations:data.distributions);
      const rows=items.map((item,index)=>{
        const title=[providerName(item.provider,meta.providerNames),item.account_name||item.account_id].filter(Boolean).join(' · ');
        const status=plan?item.available===false?'Unavailable':item.ready===true?'Ready for review':'Needs input':
          ({ACCEPTED:'Upload accepted',STARTED:'Attempt started',UNCONFIRMED:'Outcome unconfirmed',READY:'Ready'}[item.status]||workflowLabel(item.status));
        const metadata=plan?workflowFields([['Stage',item.stage==='prepare'?'Prepare an asset container':item.stage==='upload'?'Upload a copy':null]])+
          workflowNote(item.reason)+workflowNote(item.note)+workflowRows(item.problems).map(problem=>workflowNote([workflowLabel(problem.field),problem.message].filter(Boolean).join(' · '))).join(''):
          workflowFields([['Updated',workflowDate(item.updated_at)],['Provider resource',arr(item.resource_ids).join(', ')],['Error code',item.error_code]])+
          (item.status==='ACCEPTED'?workflowNote('Processing readiness is unconfirmed.'):item.status==='UNCONFIRMED'||item.status==='STARTED'?workflowNote('Check the native resource or processing status.'):'' );
        return workflowItem(title||'Destination',status,metadata+(plan&&distributionArguments(item,data,meta)?
          '<button type="button" class="media-button" data-distribution-review="'+index+'">Review '+(item.stage==='prepare'?'preparation':'upload')+'</button>':''));
      }).join('');
      const details=plan?{...data,destinations:items.map(({arguments:_arguments,fields:_fields,...item})=>item)}:data;
      app.innerHTML=chrome(operationHeader(plan?'Media distribution plan':'Media distribution status',data.asset?.name)+notices(data)+
        (rows?workflowList(rows,plan?'Eligible destinations':'Upload attempts'):workflowEmpty(plan?'No matching destinations were returned.':'No upload attempts were returned.'))+
        '<p class="provider-message" data-distribution-status role="status"></p>'+workflowDetails(details),'');
      const snapshot=state.result;
      app.querySelectorAll('[data-distribution-review]').forEach(button=>button.addEventListener('click',async()=>{
        if(distributionReview?.snapshot===snapshot||state.result!==snapshot)return;
        const item=items[Number(button.dataset.distributionReview)],args=distributionArguments(item,data,meta);
        if(!args)return;
        const pending={snapshot,item,args};distributionReview=pending;button.disabled=true;
        const indicator=app.querySelector('[data-distribution-status]');indicator.textContent='Preparing review…';
        try {
          const response=await callTool(item.tool,args,60000),value=resultData(response),actual=value?._adport;
          if(state.result!==snapshot){rememberHostResult(JSON.stringify(value));return;}
          if(response?.isError||value?.error||value.status!=='pending_validation'||value.applied!==false||
            typeof value.pending_operation_id!=='string'||!value.pending_operation_id||
            actual?.view!=='operation'||actual.provider!==item.provider||!distributionIgnoreEcho(value)) throw new Error('The upload review could not be confirmed.');
          rememberHostResult(JSON.stringify(value));
          acceptResult(response,true);
        } catch(error) {
          if(state.result===snapshot)indicator.textContent=error?.message||'Could not prepare the review.';
        } finally {
          if(distributionReview===pending)distributionReview=null;
          if(state.result===snapshot)button.disabled=false;
        }
      }));
    }
`;
