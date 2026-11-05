export const NATIVE_REPORT_TOOLS = [
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
    function nativeReportDecimal(value,scale=0) {
      const text=typeof value==='number'&&Number.isFinite(value)?String(value):typeof value==='string'?value:'';
      if(!/^-?\d+(?:\.\d+)?$/.test(text))return null;
      if(!scale)return text;
      const negative=text.startsWith('-'),[whole,fraction='']=text.replace(/^-/,'').split('.'),digits=whole+fraction,point=whole.length-scale;
      const result=(point>0?digits.slice(0,point)+'.'+digits.slice(point):'0.'+'0'.repeat(-point)+digits).replace(/^0+(?=\d)/,'').replace(/\.?0+$/,'');
      return (negative?'-':'')+(result||'0');
    }
    function nativeReportLabel(key) {
      const known={spend:'Spend',impressions:'Impressions',clicks:'Clicks',conversion:'Conversions',conversions:'Conversions',purchases:'Purchases',cpc:'CPC',cpm:'CPM',ctr:'CTR',roas:'ROAS',total_complete_payment_rate:'Purchase value',complete_payment_roas:'Purchase ROAS',lowImpressionShare:'Impression share · lower bound',highImpressionShare:'Impression share · upper bound',searchPopularity1to5:'Popularity · 1–5',searchPopularity1to100:'Popularity · 1–100',searchPopularityInGenre:'Genre popularity · 1–100',rankInGenre:'Genre rank',OverallSuccessRate:'Success rate · ratio',OverallSuccessCount:'Succeeded',SuccessCount:'Succeeded',FailureCount:'Failed',OverallUnattributedCount:'Unattributed'};
      return known[key]||known[key.toLowerCase()]||human(human(key).toLowerCase());
    }
    function nativeReportMetric(key,value,provider,currency) {
      const lower=key.toLowerCase(),decimal=nativeReportDecimal(value);
      if(value===null||value===undefined||value===''||value==='-'||value==='--')return '—';
      if(provider==='spotify'&&decimal==='-5')return 'Suppressed';
      const moneyField=/^(spend|revenue|cpc|cpm|cost_per_conversion|total_complete_payment_rate|conversion_.*_total_value)$|^(?:action_values|cost_per_action_type) · /i.test(key);
      if(moneyField) {
        if(decimal===null)return '—';
        const scale=provider==='reddit'?/total_value$/.test(lower)?2:6:0;
        const amount=nativeReportDecimal(value,scale);
        // Decimal shifting is exact even for provider counts/amounts beyond 2^53.
        return amount+' '+(currency||'account units');
      }
      return typeof value==='string'||typeof value==='number'||typeof value==='boolean'?String(value):'—';
    }
    function nativeReportRow(row,index,meta,payload) {
      if(!object(row))return '<article class="record-row"><p class="operation-note">Report row unavailable.</p></article>';
      const provider=meta.tool.split('_')[0],dimensions=object(row.dimensions)?row.dimensions:{},metrics=provider==='tiktok'&&object(row.metrics)?row.metrics:row;
      const names=provider==='microsoft'?['SearchQuery','Keyword','ConversionName','UploadDate']:provider==='apple'?['searchTerm','appName']:['ad_name','adgroup_name','adset_name','campaign_name','account_name','advertiser_name','name','entity_name'];
      const ids=['ad_id','adgroup_id','adset_id','campaign_id','advertiser_id','account_id','entity_id','id','GoalId'];
      const first=(keys,sources)=>keys.flatMap(key=>sources.map(source=>source[key])).find(value=>(typeof value==='string'&&value.trim())||typeof value==='number');
      const name=first(names,[row,metrics,dimensions]) ?? first(ids,[row,dimensions]) ?? 'Result '+(index+1);
      const status=first(['entity_status','status'],[row]);
      const dimensionKeys=['date','day','week','month','stat_time_day','stat_time_hour','country','countryOrRegion','countryCode','country_code','country_id','deviceClass','device_platform','age','gender','platform','placement','insight_value','genre','BidMatchType','match_type','date_start','date_stop','start_time','end_time'];
      const context=[...new Set(dimensionKeys.flatMap(key=>[row[key],dimensions[key]]).filter(value=>typeof value==='string'&&value))];
      const currency=[row.currency,row.account_currency,row.currency_code,metrics.currency,payload.currency,meta.currency].find(value=>typeof value==='string'&&/^[A-Z]{3}$/.test(value));
      const ignored=new Set([...names,...ids,...dimensionKeys,'currency','account_currency','currency_code','entity_type','status','entity_status','report_type','FileUrlExpiryTimeUtc','file_available','timezone']);
      let fields=provider==='spotify'?arr(row.stats).filter(stat=>typeof stat?.field_type==='string').map(stat=>[stat.field_type,stat.field_value]):Object.entries(metrics).filter(([key,value])=>!ignored.has(key)&&!/(?:_id$|Id$|hash|token|secret|url|password)/i.test(key)&&!object(value)&&!Array.isArray(value));
      if(meta.tool==='apple_impression_share'&&(Object.hasOwn(row,'lowImpressionShare')||Object.hasOwn(row,'highImpressionShare'))) {
        const bound=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1?new Intl.NumberFormat(state.host.locale||'en',{style:'percent',maximumFractionDigits:2}).format(value):'—';
        const low=bound(row.lowImpressionShare),high=bound(row.highImpressionShare);
        fields=fields.filter(([key])=>!['lowImpressionShare','highImpressionShare'].includes(key));
        fields.unshift(['Impression share',low===high?low:low+'–'+high]);
      }
      if(provider==='meta')for(const key of ['actions','action_values','purchase_roas','cost_per_action_type'])for(const item of arr(row[key]))if(typeof item?.action_type==='string')fields.push([key+' · '+item.action_type,item.value]);
      const priority=key=>/^(spend|impressions|clicks)$/i.test(key)?['spend','impressions','clicks'].indexOf(key.toLowerCase()):/^(conversion|conversions|purchases)$|^actions · purchase$/i.test(key)?3:4;
      fields.sort((a,b)=>priority(a[0])-priority(b[0]));
      const shown=fields.slice(0,4),details=fields.length>4?'<p class="apple-report-dimensions">'+(fields.length-4)+' more metric'+(fields.length===5?'':'s')+' in Details</p>':'';
      return '<article class="record-row"><div class="record-heading"><strong>'+esc(name)+'</strong>'+(status?'<span>'+esc(status)+'</span>':'')+'</div>'+(context.length?'<p class="apple-report-dimensions">'+context.map(esc).join(' · ')+'</p>':'')+(shown.length?'<dl class="record-fields apple-report-metrics native-report-metrics">'+shown.map(([key,value])=>'<div><dt>'+esc(nativeReportLabel(key))+'</dt><dd>'+esc(nativeReportMetric(key,value,provider,currency))+'</dd></div>').join('')+'</dl>':'<p class="operation-note">No metrics returned for this row.</p>')+details+'</article>';
    }
    function renderNativeReport(data,meta) {
      const payload=recordPayload(data),rows=meta.tool==='reddit_report'?payload?.metrics:payload?.rows;
      const entries=Array.isArray(rows)?rows:[],provider=meta.tool.split('_')[0];
      const title=meta.tool.includes('offline_conversion')?'Upload diagnostics':meta.tool==='apple_impression_share'?'Impression share':meta.tool==='apple_search_term_popularity'?'Search popularity':'Performance';
      const missing=Array.isArray(rows)?'No report rows returned.':'Report rows unavailable. The response is in Details.';
      const clean={...data};delete clean._adport;
      const errors=arr(data.errors).filter(error=>error?.error_code).map(error=>'<p class="notice">Goal '+esc(error.goal_id||'unavailable')+': '+esc(error.error_code)+'</p>').join('');
      const missingGoals=arr(data.not_returned_goal_ids).filter(id=>!arr(data.errors).some(error=>error?.goal_id===id&&error?.error_code));
      const absent=missingGoals.length?'<p class="notice">No summary returned for goal'+(missingGoals.length===1?'':'s')+' '+missingGoals.map(esc).join(', ')+'.</p>':'';
      app.innerHTML=chrome(operationHeader(title,'',provider)+notices({...data,errors:arr(data.errors).filter(error=>!error?.error_code)})+errors+absent+'<div class="record-list" data-native-report role="region" aria-label="Native report results" tabindex="0">'+(entries.length?entries.slice(0,1000).map((row,index)=>nativeReportRow(row,index,meta,payload)).join(''):'<p class="operation-note">'+missing+'</p>')+'</div>'+(entries.length>1000?'<p class="operation-note">Showing 1,000 returned rows. The full response is in Details.</p>':'')+'<details><summary>Details · '+entries.length+' results</summary><pre>'+esc(JSON.stringify(clean,null,2))+'</pre></details>',providerName(provider,meta.providerNames||{}));
    }
`;
