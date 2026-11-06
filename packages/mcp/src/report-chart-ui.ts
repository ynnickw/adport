export const REPORT_CHART_STYLES = String.raw`
    .report-overview { display:flex; align-items:flex-end; gap:26px; margin:4px 0 24px; min-width:0 }
    .report-overview small { display:block; color:var(--muted); font-size:10px; margin-bottom:6px }
    .report-overview strong { font-size:30px; line-height:1; letter-spacing:-.045em; font-weight:650; overflow-wrap:anywhere }
    .report-overview dl { display:flex; flex-wrap:wrap; gap:14px 24px; margin:0 0 1px; min-width:0 }
    .report-overview dt { color:var(--muted); font-size:10px; margin-bottom:5px }
    .report-overview dd { margin:0; font-size:17px; font-variant-numeric:tabular-nums }
    .report-chart { margin:16px 0 4px; min-width:0 }
    .report-chart-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:14px; color:var(--muted); font-size:11px }
    .report-chart-head b { color:var(--ink); font-size:11px; font-weight:500 }
    .report-chart-head span { font-size:10px }
    .report-bars { display:grid; gap:14px; list-style:none; padding:0; margin:0 }
    .report-bars li { min-width:0 }
    .report-bar-label { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:6px; font-size:12px }
    .report-bar-label > span { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis }
    .report-bar-label strong { flex:0 0 auto; font-size:11px; font-weight:500; font-variant-numeric:tabular-nums }
    .report-bar-track { height:10px; overflow:hidden; border-radius:4px; background:var(--soft); position:relative }
    .report-bar-fill { position:absolute; left:0; top:0; bottom:0; border-radius:4px; background:var(--orange) }
    .report-bar-range { opacity:.5; border-radius:0; border-inline:1px solid var(--orange) }
    .report-bar-zero { position:absolute; top:0; bottom:0; border-left:1px solid var(--muted) }
    .report-chart-foot { margin:10px 0 0; color:var(--muted); font-size:10px; line-height:1.5 }
    [data-native-line] svg { display:block; width:100%; overflow:visible }
    [data-native-line] text { fill:var(--muted); font:10px var(--sans) }
    [data-native-line] .chart-grid { stroke:var(--line); stroke-width:1 }
    [data-native-line] circle:focus { outline:none; stroke:var(--ink); stroke-width:2 }
    .report-legend { display:flex; flex-wrap:wrap; gap:6px 14px; margin:8px 0 0; font-size:10px; color:var(--muted) }
    .report-legend span { display:inline-flex; align-items:center; gap:5px; min-width:0; overflow-wrap:anywhere }
    .report-legend i { display:inline-block; width:12px; border-top:2px solid; flex:0 0 auto }
    .report-data { margin-top:18px }
    .report-data .record-list { margin:12px 0 }
    @media(max-width:380px) { .report-overview { gap:20px }.report-overview dl { gap:12px 18px }.report-overview strong { font-size:27px } }
`;

export const REPORT_CHART_SCRIPT = String.raw`
    function reportDate(value) {
      if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
      const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value?value:null;
    }
    function reportNumber(value) {
      const decimal=nativeReportDecimal(value);return decimal!==null&&Number.isFinite(Number(decimal))?Number(decimal):null;
    }
    function reportMetricPriority(key) {
      const value=key.replaceAll('_','').toLowerCase();
      const order=['spend','costmicros','costinlocalcurrency','costinusd','conversions','conversion','totalinstalls','installs','purchases','clicks','taps','impressions','searchpopularity1to100','searchpopularityingenre','searchpopularity1to5','overallsuccesscount','successcount'];
      const rank=order.indexOf(value);return rank<0?100:rank;
    }
    function reportCharts(records,options={}) {
      const all=[...records,...arr(options.periods)],keys=[...new Set(all.flatMap(row=>row.fields.map(field=>field.key)))];
      const key=options.metric||keys.sort((a,b)=>reportMetricPriority(a)-reportMetricPriority(b)).find(key=>all.some(row=>row.fields.some(field=>field.key===key&&available(field.value))))||keys[0];
      if(!key)return {html:'<p class="operation-note">No chartable metrics were returned.</p>',mount:()=>{}};
      const field=all.flatMap(row=>row.fields).find(field=>field.key===key),groups=new Map();
      const seriesPoints=arr(options.periods).length?options.periods:records;
      const points=seriesPoints.map(row=>{const metric=row.fields.find(field=>field.key===key);return {...row,...metric,value:metric?.value??null,display:metric?.display||'—',unit:metric?.unit||field?.unit||''};});
      for(const point of points){const unit=point.unit||'';if(!groups.has(unit))groups.set(unit,[]);groups.get(unit).push(point);}
      const models=[...groups.entries()].slice(0,4).map(([unit,returned])=>{
        const points=returned.slice(0,366);
        const unique=new Set(),dated=points.every(point=>reportDate(point.date)&&!unique.has(JSON.stringify([point.series||point.name,point.date]))&&unique.add(JSON.stringify([point.series||point.name,point.date])));
        const trend=options.mode!=='bars'&&dated&&!points.some(point=>point.range)&&new Set(points.map(point=>point.date)).size>1;
        return {unit,points,trend,returned:returned.length,label:field?.label||human(key)};
      });
      const pretty=value=>String(value).replaceAll('_',' ');
      const html=models.map((model,index)=>{
        const {points,unit,trend,label}=model;
        const title=options.label||label+(trend?' over time':options.dimension?' by '+options.dimension:' by result');
        const shown=points.slice(0,8),valid=shown.filter(point=>available(point.value)),max=Math.max(0,...valid.map(point=>point.value)),min=Math.min(0,...valid.map(point=>point.value)),span=max-min||1;
        const body=trend?'<div data-native-line="'+index+'"></div>':'<ol class="report-bars" aria-label="'+esc(title)+'">'+shown.map(point=>{
          const value=available(point.value)?point.value:null,width=value===null?0:Math.min(100,Math.abs(value)/span*100),left=value===null?0:(Math.min(value,0)-min)/span*100;
          const label=pretty(point.name)+(point.context?.length?' · '+point.context.join(' · '):'');
          const range=point.range&&point.range.every(available)?point.range:null;
          const fill=range?'<span class="report-bar-fill report-bar-range" style="left:'+Math.max(0,range[0]*100)+'%;width:'+Math.max(0,(range[1]-range[0])*100)+'%"></span>':'<span class="report-bar-fill" style="left:'+left.toFixed(5)+'%;width:'+width.toFixed(5)+'%"></span>';
          return '<li data-chart-value="'+(value===null?'':value)+'"><div class="report-bar-label"><span title="'+esc(label)+'">'+esc(label)+'</span><strong>'+esc(point.display)+'</strong></div><div class="report-bar-track" aria-hidden="true">'+fill+(min<0?'<span class="report-bar-zero" style="left:'+(-min/span*100).toFixed(5)+'%"></span>':'')+'</div></li>';
        }).join('')+'</ol>';
        return '<section class="report-chart" data-report-chart><div class="report-chart-head"><b>'+esc(title)+'</b>'+(unit?'<span>'+esc(unit)+'</span>':'')+'</div>'+body+(!trend&&model.returned>shown.length?'<p class="report-chart-foot">'+shown.length+' of '+model.returned+' returned rows · all rows in Details</p>':trend&&model.returned>points.length?'<p class="report-chart-foot">'+points.length+' of '+model.returned+' dated observations · all data in Details</p>':'')+'</section>';
      }).join('')+(groups.size>4?'<p class="report-chart-foot">Showing four units. All returned values are in Details.</p>':'');
      return {html,mount:()=>{
        const draw=()=>app.querySelectorAll('[data-native-line]').forEach(element=>{
          const model=models[Number(element.dataset.nativeLine)];if(!model)return;
          const series=new Map();for(const point of model.points){const name=point.series||point.name;if(!series.has(name))series.set(name,[]);series.get(name).push(point);}
          const chosen=[...series.entries()].slice(0,3),valid=chosen.flatMap(([,points])=>points).filter(point=>available(point.value));
          if(!valid.length){element.innerHTML='<p class="operation-note">No complete dated values were returned.</p>';return;}
          const width=Math.max(240,Math.floor(element.getBoundingClientRect?.().width||480)),height=178,left=46,right=12,top=12,bottom=30;
          const dates=[...new Set(model.points.map(point=>point.date))].sort(),start=Date.parse(dates[0]),end=Date.parse(dates.at(-1)),span=Math.max(86400000,end-start);
          const max=Math.max(1e-100,...valid.map(point=>point.value)),min=Math.min(0,...valid.map(point=>point.value)),range=max-min||1;
          const x=date=>left+(Date.parse(date)-start)/span*(width-left-right),y=value=>top+(max-value)/range*(height-top-bottom);
          const colors=['var(--orange)','var(--ink)','var(--muted)'],dashes=['','5 3','2 3'];
          const ticks=[...new Set([dates[0],dates[Math.floor((dates.length-1)/2)],dates.at(-1)])];
          const labels=ticks.map((date,index)=>'<text x="'+x(date)+'" y="'+(height-7)+'" text-anchor="'+(index===0?'start':index===ticks.length-1?'end':'middle')+'">'+esc(new Intl.DateTimeFormat(state.host.locale||'en',{month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(date)))+'</text>').join('');
          const paths=chosen.map(([name,points],index)=>{
            let line='',previous;const sorted=[...points].sort((a,b)=>a.date.localeCompare(b.date));
            for(const point of sorted){if(!available(point.value)){previous=null;continue;}const adjacent=previous&&Date.parse(point.date)-Date.parse(previous.date)===86400000;line+=(adjacent?' L':' M')+x(point.date).toFixed(2)+' '+y(point.value).toFixed(2);previous=point;}
            return '<path d="'+line+'" fill="none" stroke="'+colors[index]+'" stroke-width="2" stroke-dasharray="'+dashes[index]+'"/>'+sorted.filter(point=>available(point.value)).map(point=>'<circle cx="'+x(point.date)+'" cy="'+y(point.value)+'" r="3" fill="'+colors[index]+'" tabindex="0"><title>'+esc(pretty(name)+' · '+point.date+' · '+point.display)+'</title></circle>').join('');
          }).join('');
          const axis=value=>new Intl.NumberFormat(state.host.locale||'en',{notation:Math.abs(value)>=1000?'compact':'standard',maximumFractionDigits:3}).format(value);
          element.innerHTML='<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(model.label+' over reported dates')+'"><line class="chart-grid" x1="'+left+'" x2="'+(width-right)+'" y1="'+(height-bottom)+'" y2="'+(height-bottom)+'"/><text x="'+(left-8)+'" y="'+(top+4)+'" text-anchor="end">'+esc(axis(max))+'</text><text x="'+(left-8)+'" y="'+(height-bottom)+'" text-anchor="end">'+esc(axis(min))+'</text>'+paths+labels+'</svg>'+(chosen.length>1?'<div class="report-legend">'+chosen.map(([name],index)=>'<span><i style="border-color:'+colors[index]+';border-top-style:'+(index?'dashed':'solid')+'"></i>'+esc(pretty(name))+'</span>').join('')+'</div>':'')+(series.size>3?'<p class="report-chart-foot">3 of '+series.size+' series · all series in Details</p>':'');
        });
        draw();if(typeof ResizeObserver!=='undefined'&&models.some(model=>model.trend)){trendResize=new ResizeObserver(draw);app.querySelectorAll('[data-native-line]').forEach(element=>trendResize.observe(element));}
      }};
    }
`;
