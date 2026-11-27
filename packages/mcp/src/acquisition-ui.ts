/** Both website adapters return the same table, including when several projects share a numeric site ID. */
export const ACQUISITION_UI = String.raw`
    function renderAcquisition(data,meta) {
      const goals=meta.tool==='analytics_goals',rows=arr(goals?data.goals:data.rows),range=data.date_range;
      const provider=data.provider||meta.provider;
      const scope=[meta.providerNames?.[provider],data.account_id,
        range&&[range.start,range.end].filter(Boolean).join(' – '),range?.timezone].filter(Boolean).join(' · ');
      const pageArgs=goals?null:readPageArgs(meta,'data-report-next');
      const landing=rows.some(row=>Object.hasOwn(row.dimensions||{},'landing_page'));
      const labels=goals?['Goal','ID','Counting method']:['Source','Medium','Campaign',...(landing?['Landing page']:[]),'Sessions','Conversions','Revenue'+(data.currency?' · '+data.currency:'')];
      const format=new Intl.NumberFormat(state.host.locale||'en',{maximumFractionDigits:4});
      const amount=value=>typeof value==='number'&&Number.isFinite(value)?format.format(value):'—';
      const values=rows.map(row=>{
        if(goals)return [row.name,row.id,row.counting_method?human(row.counting_method.toLowerCase()):'—'];
        const d=row.dimensions||{},m=row.metrics||{};
        return [d.source,d.medium,d.campaign,...(landing?[d.landing_page]:[]),amount(m.sessions),amount(m.conversions),amount(m.revenue)];
      });
      const title=goals?'Conversion goals':'Conversions by acquisition';
      const clean={...data};delete clean._adport;
      const body=values.length?workflowTable(labels,values,title):workflowNote(goals?'No conversion goals configured for this site.':'No acquisition rows returned for these dates.');
      app.innerHTML=chrome(operationHeader(title,scope,provider)+notices(data)+'<section data-native-report data-read-page-focus tabindex="-1">'+body+
        readPageMarkup(pageArgs,'data-report-next','data-report-page-status')+
        '<details class="report-data"><summary>Details · '+rows.length+' results</summary>'+workflowNote(data.attribution)+workflowNote(data.revenue_basis)+
        '<pre>'+esc(JSON.stringify(clean,null,2))+'</pre></details></section>','');
      bindReadPage(meta,pageArgs,'data-report-next','data-report-page-status',value=>Array.isArray(value?.rows));
    }
`;
