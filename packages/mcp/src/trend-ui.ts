export const TREND_UI_STYLES = String.raw`
    .report-trend { min-width:0; margin:12px 0 0 }
    .report-trend svg { display:block; width:100%; overflow:visible }
    .report-trend text { fill:var(--muted); font-family:var(--sans); font-size:11px }
    .report-trend .trend-line { fill:none; stroke:var(--orange); stroke-width:2; stroke-linejoin:round }
    .report-trend circle { fill:var(--orange) }
    .report-trend .trend-grid { stroke:var(--line); stroke-width:1 }
`;

export const TREND_UI_SCRIPT = String.raw`
    let trendResize;
    function dailyObservations(rows,metric,errors) {
      const dates=[...new Set(rows.map(row=>row.date).filter(date=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date))].sort();
      return dates.map(date=>{
        const selected=rows.filter(row=>row.date===date);
        let value=null;
        if(!arr(errors).some(error=>error.date===date && (!error.provider || rows.some(row=>row.provider===error.provider)))) {
          if(metric==='roas') {
            const spend=total(selected,'spend'),returns=selected.map(rowReturn);
            if(spend>0&&returns.every(available))value=returns.reduce((sum,item)=>sum+item,0)/spend;
          } else value=total(selected,metric);
        }
        return {date,value};
      });
    }
    function mountReportTrend(rows,metric,currency,data) {
      const element=app.querySelector('[data-report-trend]');if(!element)return;
      const observations=dailyObservations(rows,metric,data.errors),valid=observations.filter(item=>available(item.value));
      const draw=()=>{
        if(!valid.length){element.innerHTML='<p class="operation-note">No complete dated values were returned for this metric.</p>';return;}
        const width=Math.max(240,Math.floor(element.getBoundingClientRect?.().width || 480)),height=166,left=54,right=16,top=12,bottom=35;
        const start=Date.parse(data.resolved_date_range?.start || observations[0].date),end=Date.parse(data.resolved_date_range?.end || observations.at(-1).date),span=Math.max(86400000,end-start);
        const max=Math.max(1,...valid.map(item=>item.value)),min=Math.min(0,...valid.map(item=>item.value)),range=max-min || 1;
        const x=date=>left+(Date.parse(date)-start)/span*(width-left-right),y=value=>top+(max-value)/range*(height-top-bottom);
        const format=value=>metric==='spend'?money(value,currency):metric==='roas'?value.toFixed(2)+'×':compact(value);
        const axisFormat=value=>Math.abs(value)<1000?format(value):new Intl.NumberFormat(state.host.locale||undefined,{notation:'compact',maximumFractionDigits:1}).format(value);
        let line='',previous;
        for(const point of observations) {
          if(!available(point.value)){previous=undefined;continue;}
          const contiguous=previous&&Date.parse(point.date)-Date.parse(previous.date)===86400000;
          line+=(contiguous?' L':' M')+x(point.date).toFixed(2)+' '+y(point.value).toFixed(2);previous=point;
        }
        const ticks=[...new Set([observations[0].date,observations[Math.floor((observations.length-1)/2)].date,observations.at(-1).date])];
        const labels=ticks.map((date,index)=>'<text x="'+x(date)+'" y="'+(height-9)+'" text-anchor="'+(index===0?'start':index===ticks.length-1?'end':'middle')+'">'+esc(new Intl.DateTimeFormat(state.host.locale||undefined,{month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(date+'T00:00:00Z')))+'</text>').join('');
        const summary=valid.map(point=>point.date+': '+format(point.value)).join('; ');
        element.innerHTML='<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Daily '+esc(metric)+'; '+esc(summary)+'"><line class="trend-grid" x1="'+left+'" x2="'+(width-right)+'" y1="'+(height-bottom)+'" y2="'+(height-bottom)+'"/><text x="'+(left-7)+'" y="'+(top+4)+'" text-anchor="end">'+esc(axisFormat(max))+'</text><text x="'+(left-7)+'" y="'+(height-bottom)+'" text-anchor="end">'+esc(axisFormat(min))+'</text><path class="trend-line" d="'+line+'"/>'+valid.map(point=>'<circle cx="'+x(point.date)+'" cy="'+y(point.value)+'" r="3"><title>'+esc(point.date+' · '+format(point.value))+'</title></circle>').join('')+labels+'</svg>';
      };
      draw();
      if(typeof ResizeObserver!=='undefined'){trendResize=new ResizeObserver(draw);trendResize.observe(element);}
    }
`;
