/** Presentation adapters retain native counts, bounds, dates, and units. */
export const PLANNING_UI = String.raw`
    const forecastNames=new Set(['meta_delivery_estimate','pinterest_audience_estimate','snapchat_audience_size','spotify_audience_estimate','spotify_bid_estimate']);

    function planningMicros(value) {
      const amount=nativeReportDecimal(value,6);
      return amount===null?null:amount+' account units';
    }

    function monthlyHistory(months) {
      const names=['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
      const points=new Map();
      for(const row of workflowRows(months)) {
        const month=names.indexOf(String(row.month).toUpperCase()), year=String(row.year);
        if(month<0||!/^[1-9]\d{3}$/.test(year))continue;
        const date=year+'-'+String(month+1).padStart(2,'0'),value=nativeReportDecimal(row.monthlySearches);
        points.set(date,{date,index:Number(year)*12+month,value});
      }
      return [...points.values()].sort((a,b)=>a.index-b.index).slice(-24);
    }

    function monthlySparkline(points) {
      const valid=points.filter(point=>point.value!==null && Number.isFinite(Number(point.value)) && Number(point.value)>=0);
      if(!valid.length)return '—';
      const width=96,height=22,start=points[0].index,span=Math.max(1,points.at(-1).index-start),max=Math.max(1,...valid.map(point=>Number(point.value)));
      let path='',previous=null;
      const dots=[];
      for(const point of valid) {
        const x=3+(point.index-start)/span*(width-6),y=height-3-Number(point.value)/max*(height-6);
        const adjacent=previous===point.index-1;
        path+=(adjacent?' L':' M')+x.toFixed(2)+' '+y.toFixed(2);
        dots.push('<circle cx="'+x+'" cy="'+y+'" r="2" fill="var(--orange)"/>');
        previous=point.index;
      }
      const label=points.map(point=>point.date+': '+(point.value??'unavailable')).join(', ');
      return '<svg width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(label)+'"><title>'+esc(label)+'</title>'+
        '<path d="'+path+'" fill="none" stroke="var(--orange)" stroke-width="1.5"/>'+
        dots.join('')+'</svg>';
    }

    function planningProjection(data,meta) {
      const tool=meta.tool;
      if(/^google_keyword_(?:ideas|historical_metrics)$/.test(tool)) {
        return {title:'Keyword research',columns:[
          {key:'keyword',label:'Keyword'},{key:'volume',label:'Average monthly searches'},{key:'competition',label:'Competition'},
          {key:'low',label:'Low top-of-page bid'},{key:'high',label:'High top-of-page bid'},{key:'history',label:'Monthly history'}
        ],rows:workflowRows(data.results).map(row=>{
          const metrics=row.keywordIdeaMetrics??row.keywordMetrics??{};
          return {keyword:row.text,volume:nativeReportDecimal(metrics.avgMonthlySearches),competition:workflowLabel(metrics.competition),
            low:planningMicros(metrics.lowTopOfPageBidMicros),high:planningMicros(metrics.highTopOfPageBidMicros),
            history:monthlyHistory(metrics.monthlySearchVolumes)};
        }),notes:['Historical estimates. Google groups close variants in historical results.']};
      }
      if(/^microsoft_keyword_(?:ideas|historical_metrics)$/.test(tool)) {
        return {title:'Keyword research',columns:[
          {key:'keyword',label:'Keyword'},{key:'competition',label:'Competition'},{key:'bid',label:'Suggested bid'},
          {key:'history',label:'Monthly counts (newest first)'}
        ],rows:workflowRows(data.rows).map(row=>({
          keyword:row.Keyword,competition:workflowLabel(row.Competition),
          bid:nativeReportDecimal(row.SuggestedBid)===null?null:nativeReportDecimal(row.SuggestedBid)+' '+(currencyOf(data)||'account units'),
          history:arr(row.MonthlySearchCounts).slice(0,24).map(item=>nativeReportDecimal(item)??'—').join(' · ')
        })),notes:data.notes};
      }
      if(/^apple_(?:search_)?suggestions$/.test(tool)) {
        const rows=workflowRows(data.result).map(row=>({
          term:row.phrase??row.keyword??row.category??row.name,
          popularity:row.searchPopularity??row.searchPopularity1to5??row.searchPopularity1to100,
          position:row.rank
        })).filter(row=>workflowText(row.term));
        if(!rows.length && arr(data.result).length)return null;
        return {title:'Keyword suggestions',columns:[{key:'term',label:'Term or category'},{key:'popularity',label:'Native popularity'},{key:'position',label:'Native rank'}],rows};
      }
      if(tool==='microsoft_keyword_traffic_estimates') {
        const rows=workflowRows(data.rows).flatMap(campaign=>workflowRows(campaign.AdGroupEstimates).flatMap(group=>workflowRows(group.KeywordEstimates))).flatMap(item=>{
          const term=object(item.Keyword)?item.Keyword.Text:item.Keyword;
          return Object.entries({Minimum:item.Minimum,Maximum:item.Maximum}).filter(([,value])=>object(value)).map(([bound,value])=>({
            row:[term,bound].filter(workflowText).join(' · '),clicks:value.Clicks,impressions:value.Impressions,
            cost:nativeReportDecimal(value.TotalCost)===null?null:nativeReportDecimal(value.TotalCost)+' '+(currencyOf(data)||'account units')
          }));
        });
        if(!rows.length&&arr(data.rows).length)return null;
        return {title:'Weekly traffic estimates',columns:[{key:'row',label:'Keyword and bound'},{key:'clicks',label:'Clicks'},
          {key:'impressions',label:'Impressions'},{key:'cost',label:'Total cost'}],rows,notes:data.notes};
      }
      if(forecastNames.has(tool)) {
        const values=tool==='meta_delivery_estimate'?workflowRows(data.estimates):[object(data.value)?data.value:data];
        const rows=values.flatMap((value,index)=>dataFields(value)
          .filter(field=>/audience|size|estimate|bound|minimum|maximum|lower|upper|reach|bid|impression|dau|mau|ready|status|currency/i.test(field.label)&&workflowText(field.after))
          .map(field=>({estimate:(values.length>1?'Estimate '+(index+1)+' · ':'')+field.label,value:/(^|\s)micros?$/i.test(field.label)?
            (nativeReportDecimal(field.after,6)??'—')+' '+(currencyOf(value)||'account units'):field.after}))
        );
        if(!rows.length && values.length)return null;
        return {title:tool==='spotify_bid_estimate'?'Bid estimate':tool==='meta_delivery_estimate'?'Delivery estimates':'Audience estimate',
          columns:[{key:'estimate',label:'Native measure'},{key:'value',label:'Estimate'}],rows,
          notes:['Estimates reflect the selected targeting and provider assumptions.']};
      }
      return null;
    }

    function renderPlanning(data,meta,projected) {
      const planning=projected||data.planning||{};
      const columns=arr(planning.columns).filter(value=>typeof value?.key==='string'&&typeof value?.label==='string').slice(0,12);
      const rows=arr(planning.rows),pageSize=100,pages=Math.max(1,Math.ceil(rows.length/pageSize));
      state.planningPage=Math.max(0,Math.min(state.planningPage,pages-1));
      const start=state.planningPage*pageSize,shown=rows.slice(start,start+pageSize);
      const notes=arr(planning.notes).filter(workflowText).map(note=>'<p class="notice">'+esc(note)+'</p>').join('');
      const detailHeader=projected?workflowHeader(columns.map(column=>column.label)):
        '<thead><tr>'+columns.map(column=>'<th scope="col">'+esc(column.label)+'</th>').join('')+'</tr></thead>';
      const detailRows=shown.map(row=>'<tr'+(projected?' role="row"':'')+'>'+columns.map((column,i)=>{
        const value=row&&Object.hasOwn(row,column.key)?row[column.key]:null;
        const html=column.key==='history'&&Array.isArray(value)&&projected?monthlySparkline(value):esc(value==null?'—':value);
        return projected?workflowCell(column.label,html,i===0):'<td>'+html+'</td>';
      }).join('')+'</tr>').join('');
      const table=columns.length&&shown.length?'<div class="planning-scroll" tabindex="0" role="region" aria-label="Planning estimate table">'+
        (projected?'<table class="planning-table workflow-stack" role="table">':'<table class="planning-table">')+detailHeader+
        (projected?'<tbody role="rowgroup">':'<tbody>')+detailRows+'</tbody></table></div>':workflowEmpty('No planning values were returned for this selection.');
      const controls=pages>1?'<div class="planning-pages"><button type="button" data-planning-page="previous" '+(state.planningPage===0?'disabled':'')+'>Previous rows</button><span class="context">Rows '+(start+1)+'–'+(start+shown.length)+' of '+rows.length+'</span><button type="button" data-planning-page="next" '+(state.planningPage===pages-1?'disabled':'')+'>Next rows</button></div>':'';
      const args=readPageArgs(meta,'data-planning-next');
      app.innerHTML=chrome(operationHeader(planning.title||'Planning estimates',meta.accountId,meta.provider)+notices({...data,notes:arr(data.notes).filter(note=>!arr(planning.notes).includes(note)),truncated:false})+
        '<div data-read-page-focus tabindex="-1">'+table+controls+(data.truncated?'<p class="notice">Partial native response. More estimates may exist.</p>':'')+notes+
        readPageMarkup(args,'data-planning-next','data-planning-status')+workflowDetails(data)+'</div>','Read-only estimates');
      app.querySelectorAll('[data-planning-page]').forEach(button=>button.addEventListener('click',()=>{
        if(button.disabled)return;
        state.planningPage+=button.dataset.planningPage==='next'?1:-1;
        renderPlanning(data,meta,projected);
      }));
      bindReadPage(meta,args,'data-planning-next','data-planning-status',value=>!!planningProjection(value,meta)||Array.isArray(value.planning?.rows));
    }
`;
