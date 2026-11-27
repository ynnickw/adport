import { GAQL_REPORT_UI } from './gaql-report-ui.js';

export const NATIVE_REPORT_TOOLS = [
  'ga4_report', 'ga4_realtime_report', 'gsc_search_analytics', 'matomo_report', 'matomo_campaign_performance', 'matomo_realtime_report',
  'google_gaql', 'gravity_conversion_stats',
  'linkedin_demographic_report',
  'meta_insights', 'tiktok_report', 'reddit_report', 'spotify_insight_report',
  'microsoft_keyword_report', 'microsoft_search_term_report',
  'microsoft_offline_conversion_reports', 'microsoft_offline_conversion_goal_report',
  'apple_impression_share', 'apple_search_term_popularity',
] as const;

export const NATIVE_REPORT_UI_STYLES = String.raw`
    .native-report-metrics { grid-template-columns:repeat(auto-fit,minmax(min(110px,100%),1fr)) }
`;

/** Each native read retains its own metrics, attribution and units. */
export const NATIVE_REPORT_UI_SCRIPT = String.raw`
    const nativeReportTools=new Set(${JSON.stringify(NATIVE_REPORT_TOOLS)});
    ${GAQL_REPORT_UI}
    function nativeReportDecimal(value,scale=0) {
      const text=typeof value==='number'&&Number.isFinite(value)?String(value):typeof value==='string'?value:'';
      if(!/^-?\d+(?:\.\d+)?$/.test(text))return null;
      if(!scale)return text;
      const negative=text.startsWith('-'),[whole,fraction='']=text.replace(/^-/,'').split('.'),digits=whole+fraction,point=whole.length-scale;
      const result=(point>0?digits.slice(0,point)+'.'+digits.slice(point):'0.'+'0'.repeat(-point)+digits).replace(/^0+(?=\d)/,'').replace(/\.?0+$/,'');
      return (negative?'-':'')+(result||'0');
    }
    function nativeReportLabel(key) {
      const known={spend:'Spend',costMicros:'Spend',conversionsValue:'Conversion value',impressions:'Impressions',clicks:'Clicks',conversion:'Conversions',conversions:'Conversions',purchases:'Purchases',cpc:'CPC',cpm:'CPM',ctr:'CTR',roas:'ROAS',total_complete_payment_rate:'Purchase value',complete_payment_roas:'Purchase ROAS',lowImpressionShare:'Impression share · lower bound',highImpressionShare:'Impression share · upper bound',searchPopularity1to5:'Popularity · 1–5',searchPopularity1to100:'Popularity · 1–100',searchPopularityInGenre:'Genre popularity · 1–100',rankInGenre:'Genre rank',OverallSuccessRate:'Success rate · ratio',OverallSuccessCount:'Succeeded',SuccessCount:'Succeeded',FailureCount:'Failed',OverallUnattributedCount:'Unattributed'};
      return known[key]||known[key.toLowerCase()]||human(human(key).toLowerCase());
    }
    function nativeReportRatio(key,provider,percentFields=[]) {return percentFields.includes(key)||(provider==='gsc'||provider==='google')&&key==='ctr'||provider==='ga4'&&!key.includes(':')&&/Rate$/.test(key);}
    function nativeReportMetric(key,value,provider,currency,moneyFields=[],percentFields=[],durationFields=[]) {
      if(key==='costInUsd')currency='USD';
      const lower=key.toLowerCase(),decimal=nativeReportDecimal(value);
      if(value===null||value===undefined||value===''||value==='-'||value==='--')return '—';
      if(provider==='spotify'&&decimal==='-5')return 'Suppressed';
      if(nativeReportRatio(key,provider,percentFields)&&decimal!==null)return new Intl.NumberFormat(state.host.locale||'en',{style:'percent',maximumFractionDigits:2}).format(Number(decimal));
      if(durationFields.includes(key)&&decimal!==null)return nativeReportDuration(Number(decimal));
      const moneyField=nativeReportMoneyField(key,provider,moneyFields);
      if(moneyField) {
        if(decimal===null)return '—';
        const scale=nativeReportScale(key,provider);
        const amount=nativeReportDecimal(value,scale);
        // Decimal shifting is exact even for provider counts/amounts beyond 2^53.
        return amount+' '+(currency||'account units');
      }
      return typeof value==='string'||typeof value==='number'||typeof value==='boolean'?String(value):'—';
    }
    function nativeReportDuration(seconds) {
      const total=Math.round(Math.abs(seconds)),h=Math.floor(total/3600),m=Math.floor(total%3600/60),s=total%60;
      return (seconds<0?'-':'')+(h?h+'h '+m+'m '+s+'s':m?m+'m '+s+'s':s+'s');
    }
    function nativeReportMoneyField(key,provider,moneyFields=[]) {
      return moneyFields.includes(key)||/^(spend|revenue|cpc|cpm|cost_per_conversion|costInLocalCurrency|costInUsd|total_complete_payment_rate|conversion_.*_total_value)$|^(?:action_values|cost_per_action_type) · /i.test(key)||provider==='google'&&(/Micros$/.test(key)||/conversionsValue$/i.test(key));
    }
    function nativeReportScale(key,provider) { return provider==='reddit'?/total_value$/i.test(key)?2:6:provider==='google'&&/Micros$/.test(key)?6:0; }
    function reportBucket(value) {
      if(value==='LESS_THAN_ONE_DAY')return 'Under 1 day';
      const words={ONE:1,TWO:2,THREE:3,FOUR:4,FIVE:5,SIX:6,SEVEN:7,EIGHT:8,NINE:9,TEN:10,ELEVEN:11,TWELVE:12,THIRTEEN:13,FOURTEEN:14,TWENTY_ONE:21,THIRTY:30,FORTY_FIVE:45,SIXTY:60,NINETY:90};
      const match=typeof value==='string'&&value.match(/^(.+)_TO_(.+)_DAYS$/);
      return match&&words[match[1]]!==undefined&&words[match[2]]!==undefined?words[match[1]]+'–'+words[match[2]]+' days':human(String(value).toLowerCase());
    }
    function nativeReportRecord(row,index,meta,payload) {
      if(!object(row))return null;
      const provider=meta.tool.split('_')[0],dimensions=object(row.dimensions)?row.dimensions:provider==='google'&&object(row.segments)?row.segments:{},metrics=['tiktok','google','linkedin','ga4','gsc','matomo'].includes(provider)&&object(row.metrics)?row.metrics:row;
      const names=provider==='gravity'?['date']:provider==='microsoft'?['SearchQuery','Keyword','ConversionName','UploadDate']:provider==='apple'?['searchTerm','appName']:['ad_name','adgroup_name','adset_name','campaign_name','account_name','advertiser_name','name','entity_name'];
      const ids=['ad_id','adgroup_id','adset_id','campaign_id','advertiser_id','account_id','entity_id','id','GoalId','urn'];
      const first=(keys,sources)=>keys.flatMap(key=>sources.map(source=>source[key])).find(value=>(typeof value==='string'&&value.trim())||typeof value==='number');
      const googleDimensions=provider==='google'?gaqlDimensions(row):null;
      const googleEntity=googleDimensions&&[...gaqlEntities.keys()].find(path=>googleDimensions.has(path));
      const googleName=googleDimensions?.get(googleEntity);
      const bucket=dimensions.conversionLagBucket??dimensions.conversionOrAdjustmentLagBucket;
      const analyticsName=['ga4','gsc','matomo'].includes(provider)?Object.entries(dimensions).filter(([key])=>key!=='period_label').map(([,value])=>value).filter(value=>typeof value==='string'&&value).join(' · ')||first(['period_label'],[dimensions])||first(['name'],[payload.report||{}]):null;
      const name=bucket?reportBucket(bucket):googleName??analyticsName??first(names,[row,metrics,dimensions]) ?? first(ids,[row,dimensions]) ?? (provider==='google'?'Report':'Result '+(index+1));
      const status=first(['entity_status','status'],[row]);
      const dimensionKeys=['date','day','week','month','stat_time_day','stat_time_hour','country','countryOrRegion','countryCode','country_code','country_id','deviceClass','device_platform','age','gender','platform','placement','insight_value','genre','BidMatchType','match_type','date_start','date_stop','start_time','end_time'];
      const context=[...new Set([...dimensionKeys.flatMap(key=>[row[key],dimensions[key]]),...(provider==='google'?Object.entries(dimensions).filter(([key,value])=>!['conversionLagBucket','conversionOrAdjustmentLagBucket','date'].includes(key)&&typeof value==='string').map(([,value])=>human(value.toLowerCase())):[]),...(bucket&&googleName?[googleName]:[])].filter(value=>typeof value==='string'&&value))];
      const currency=[row.currency,row.account_currency,row.currency_code,row.customer?.currencyCode,metrics.currency,payload.currency,payload.metadata?.currencyCode,meta.currency].find(value=>typeof value==='string'&&/^[A-Z]{3}$/.test(value));
      const ignored=new Set([...names,...ids,...dimensionKeys,'currency','account_currency','currency_code','entity_type','status','entity_status','report_type','FileUrlExpiryTimeUtc','file_available','timezone']);
      let fields=provider==='spotify'?arr(row.stats).filter(stat=>typeof stat?.field_type==='string').map(stat=>[stat.field_type,stat.field_value]):Object.entries(metrics).filter(([key,value])=>!ignored.has(key)&&!/(?:_id$|Id$|hash|token|secret|url|password)/i.test(key)&&!object(value)&&!Array.isArray(value));
      if(meta.tool==='apple_impression_share'&&(Object.hasOwn(row,'lowImpressionShare')||Object.hasOwn(row,'highImpressionShare'))) {
        const bound=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1?new Intl.NumberFormat(state.host.locale||'en',{style:'percent',maximumFractionDigits:2}).format(value):'—';
        const low=bound(row.lowImpressionShare),high=bound(row.highImpressionShare);
        fields=fields.filter(([key])=>!['lowImpressionShare','highImpressionShare'].includes(key));
        fields.unshift(['Impression share',low===high?low:low+'–'+high]);
      }
      if(provider==='meta')for(const key of ['actions','action_values','purchase_roas','cost_per_action_type'])for(const item of arr(row[key]))if(typeof item?.action_type==='string')fields.push([key+' · '+item.action_type,item.value]);
      if(provider==='linkedin'&&row.date_range?.start&&row.date_range?.end){const period=row.date_range.start+' – '+row.date_range.end;context.push(period);fields.push(['period',period]);}
      const priority=key=>/^(spend|impressions|clicks)$/i.test(key)?['spend','impressions','clicks'].indexOf(key.toLowerCase()):/^(conversion|conversions|purchases)$|^actions · purchase$/i.test(key)?3:4;
      fields.sort((a,b)=>priority(a[0])-priority(b[0]));
      const matomoTypes=provider==='matomo'&&object(payload.metric_types)?payload.metric_types:{},typed=type=>Object.keys(matomoTypes).filter(key=>matomoTypes[key]===type);
      const moneyFields=provider==='ga4'?arr(payload.metric_headers).filter(header=>header.type==='TYPE_CURRENCY').map(header=>header.name):typed('money');
      const percentFields=typed('percent'),durationFields=typed('duration_s');
      return {name,status,context,currency,moneyFields,percentFields,durationFields,provider,fields,gaqlDimensions:googleDimensions,gaqlEntity:googleEntity,native:row,date:reportDate(dimensions.stat_time_day??(provider==='ga4'&&/^\d{8}$/.test(dimensions.date||'')?dimensions.date.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'):dimensions.date)??(row.date_start===row.date_stop?row.date_start:null)??(row.date_range?.start===row.date_range?.end?row.date_range?.start:null)),series:googleName||(['ga4','gsc','matomo'].includes(provider)?Object.entries(dimensions).filter(([key])=>key!=='date'&&key!=='period_label').map(([,value])=>value).join(' · ')||'Website':name)};
    }
    function nativeChartRecord(record) {
      if(!record)return {name:'Unavailable row',context:[],fields:[]};
      const fields=record.fields.map(([key,raw])=>{
        const monetary=nativeReportMoneyField(key,record.provider,record.moneyFields),scaled=nativeReportDecimal(raw,nativeReportScale(key,record.provider));
        const ratio=nativeReportRatio(key,record.provider,record.percentFields);
        const value=record.provider==='spotify'&&String(raw)==='-5'?null:reportNumber(monetary?scaled:raw);
        const display=nativeReportMetric(key,raw,record.provider,record.currency,record.moneyFields,record.percentFields,record.durationFields);
        const googleMoney=record.provider==='google'&&monetary;
        const shortDisplay=googleMoney&&scaled!==null?gaqlAmount(scaled,record.currency):undefined;
        return {key,label:key==='costInLocalCurrency'?'Spend':key==='costInUsd'?'Spend · USD':nativeReportLabel(key),value:ratio&&value!==null?value*100:value,display,shortDisplay,unit:ratio?'%':record.durationFields?.includes(key)?'s':monetary?key==='costInUsd'?'USD':record.currency||(googleMoney?'Currency unavailable':'Account units'):''};
      });
      const low=record.native.lowImpressionShare,high=record.native.highImpressionShare;
      const range=record.provider==='apple'&&[low,high].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1)&&low<=high?[low,high]:undefined;
      if(range){const field=fields.find(field=>field.key==='Impression share');if(field){field.value=low;field.unit='%';}}
      return {...record,fields,range,series:[record.series,...record.context.filter(value=>!reportDate(value)&&!(/^\d{8}$/.test(value)&&record.provider==='ga4')&&!/^\d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}$/.test(value))].join(' · ')};
    }
    function nativeReportRow(row,index,meta,payload) {
      const record=nativeReportRecord(row,index,meta,payload);
      if(!record)return '<article class="record-row"><p class="operation-note">Report row unavailable.</p></article>';
      const {name,status,context,currency,provider,fields,moneyFields,percentFields,durationFields}=record;
      const shown=fields.slice(0,4),details=fields.length>4?'<p class="apple-report-dimensions">'+(fields.length-4)+' more metric'+(fields.length===5?'':'s')+' in Details</p>':'';
      return '<article class="record-row"><div class="record-heading"><div class="record-name"><strong>'+esc(name)+'</strong></div>'+(status?'<span>'+esc(status)+'</span>':'')+'</div>'+(context.length?'<p class="apple-report-dimensions">'+context.map(esc).join(' · ')+'</p>':'')+(shown.length?'<dl class="record-fields apple-report-metrics native-report-metrics">'+shown.map(([key,value])=>'<div><dt>'+esc(nativeReportLabel(key))+'</dt><dd>'+esc(nativeReportMetric(key,value,provider,currency,moneyFields,percentFields,durationFields))+'</dd></div>').join('')+'</dl>':'<p class="operation-note">No metrics returned for this row.</p>')+details+'</article>';
    }
    function renderNativeReport(data,meta) {
      const payload=meta.tool==='linkedin_demographic_report'?data:recordPayload(data),rows=meta.tool==='reddit_report'?payload?.metrics:meta.tool==='gravity_conversion_stats'?payload?.time_series:payload?.rows;
      const entries=Array.isArray(rows)?rows:[],provider=meta.tool.split('_')[0];
      const title=meta.tool==='gravity_conversion_stats'?'Conversions by day':meta.tool.includes('offline_conversion')?'Upload diagnostics':meta.tool==='apple_impression_share'?'Impression share':meta.tool==='apple_search_term_popularity'?'Search popularity':provider==='ga4'?'Website analytics':provider==='gsc'?'Organic search':provider==='matomo'?'Matomo analytics':'Performance';
      const missing=Array.isArray(rows)?'No report rows returned.':'Report rows unavailable. The response is in Details.';
      const clean={...data};delete clean._adport;
      const errors=arr(data.errors).filter(error=>error?.error_code).map(error=>'<p class="notice">Goal '+esc(error.goal_id||'unavailable')+': '+esc(error.error_code)+'</p>').join('');
      const missingGoals=arr(data.not_returned_goal_ids).filter(id=>!arr(data.errors).some(error=>error?.goal_id===id&&error?.error_code));
      const absent=missingGoals.length?'<p class="notice">No summary returned for goal'+(missingGoals.length===1?'':'s')+' '+missingGoals.map(esc).join(', ')+'.</p>':'';
      const records=entries.slice(0,1000).map((row,index)=>nativeReportRecord(row,index,meta,payload)),delay=provider==='google'&&entries.some(row=>row?.segments?.conversionLagBucket||row?.segments?.conversionOrAdjustmentLagBucket);
      const pageArgs=['ga4_report','gsc_search_analytics','matomo_report','matomo_campaign_performance'].includes(meta.tool)?readPageArgs(meta,'data-report-next'):null;
      const points=records.map(nativeChartRecord);
      const table=provider==='google'&&!delay&&entries.length?gaqlReportTable(records,points):null;
      const entity=records[0]?.gaqlEntity;
      const dimension=entity&&records.every(row=>row?.gaqlEntity===entity)?gaqlEntities.get(entity).toLowerCase():undefined;
      const chart=table?null:reportCharts(points,delay?{dimension:'delay',mode:'bars',metric:records.some(record=>record?.fields.some(([key])=>key==='conversions'))?'conversions':undefined}:meta.tool==='apple_impression_share'?{metric:'Impression share',dimension:'search term'}:{dimension});
      const analytics=['ga4','gsc','matomo'].includes(provider),range=payload?.date_range;
      const period=analytics&&object(range)?[range.start_date??range.start,range.end_date??range.end].filter(workflowText).join(' – '):'';
      const subject=table?.subject||(analytics?[meta.accountId,period].filter(Boolean).join(' · '):'');
      const body=table?.html||(entries.length?chart.html:'<p class="operation-note">'+missing+'</p>');
      app.innerHTML=chrome(operationHeader(table?.title||(delay?'Conversion delay':title),subject,provider)+notices({...data,...(meta.tool==='linkedin_demographic_report'?{notes:[]}:{}),errors:arr(data.errors).filter(error=>!error?.error_code)})+errors+absent+'<section data-native-report data-read-page-focus tabindex="-1">'+body+(meta.tool==='linkedin_demographic_report'?'<p class="report-chart-foot">Approximate demographics · privacy thresholds apply</p>':'')+(entries.length>1000?'<p class="operation-note">Showing 1,000 returned rows. The full response is in Details.</p>':'')+readPageMarkup(pageArgs,'data-report-next','data-report-page-status')+'<details class="report-data"><summary>Details · '+entries.length+' results</summary>'+(!table&&entries.length?'<div class="record-list" role="region" aria-label="Native report data" tabindex="0">'+entries.slice(0,1000).map((row,index)=>nativeReportRow(row,index,meta,payload)).join('')+'</div>':'')+'<pre>'+esc(JSON.stringify(clean,null,2))+'</pre></details></section>',table?entries.length+(entries.length===1?' row':' rows'):'');
      chart?.mount();
      bindReadPage(meta,pageArgs,'data-report-next','data-report-page-status',value=>Array.isArray(recordPayload(value)?.rows));
    }
`;
