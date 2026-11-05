/** Native Apple report rows retain totals, time buckets and metadata separately. */
export const APPLE_REPORT_UI_STYLES = String.raw`
    .apple-report-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-top:9px }
    .apple-report-metrics dt { display:block; margin:0 0 3px; font-size:10px }
    .apple-report-metrics dd { font-size:12px; font-variant-numeric:tabular-nums }
    .apple-report-total { padding:12px 0 0 }
    .apple-report-total > strong { font-size:11px }
    .apple-report-dimensions { margin:4px 0 0; color:var(--muted); font-size:10px; overflow-wrap:anywhere }
    .apple-report-periods { margin:10px 0 0; padding-top:8px }
    .apple-report-periods summary { font-size:10px }
    .apple-report-period { margin-top:10px }
    .apple-report-period > strong { font-size:10px; font-weight:500 }
    .apple-report-page { margin:10px 0 0; color:var(--muted); font-size:10px }
`;

export const APPLE_REPORT_UI_SCRIPT = String.raw`
    function appleReportNumber(value) {
      if(typeof value==='string' && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))return null;
      return (typeof value==='number'||typeof value==='string') && Number.isFinite(Number(value)) && Number(value)>=0?Number(value):null;
    }
    function appleReportMoney(value) {
      const amount=object(value)?appleReportNumber(value.amount):null;
      if(amount===null)return '—';
      const currency=currencyOf(value);
      return currency?money(amount,currency):money(amount,null)+' (currency unavailable)';
    }
    function appleReportMetrics(value) {
      const metrics=object(value)?value:{},taps=appleReportNumber(metrics.taps),installs=appleReportNumber(metrics.totalInstalls);
      // Apple's zero CPI for zero installs is undefined, not a free acquisition.
      const fields=[['Spend',appleReportMoney(metrics.localSpend)],['Taps',taps===null?'—':taps.toLocaleString(state.host.locale||'en')],['Installs',installs===null?'—':installs.toLocaleString(state.host.locale||'en')],['CPI',installs===0?'—':appleReportMoney(metrics.totalAvgCPI)]];
      return '<dl class="record-fields apple-report-metrics">'+fields.map(([label,value])=>'<div><dt>'+esc(label)+'</dt><dd>'+esc(value)+'</dd></div>').join('')+'</dl>';
    }
    function appleReportRow(row,index) {
      const metadata=object(row?.metadata)?row.metadata:{},keyword=object(metadata.keyword)?metadata.keyword:{};
      const name=[metadata.searchTermText,metadata.text,metadata.name,keyword.text].find(value=>typeof value==='string'&&value.trim()) ?? (metadata.id!==undefined?String(metadata.id):'Unnamed result '+(index+1));
      const status=[metadata.displayStatus,metadata.systemStatus,metadata.status].find(value=>typeof value==='string'&&value);
      const dimensions=['countryOrRegion','countryCode','adminArea','locality','deviceClass','ageRange','gender'].flatMap(key=>typeof metadata[key]==='string'&&metadata[key]?[metadata[key]]:[]);
      const matchType=metadata.matchType||keyword.matchType;
      if(typeof matchType==='string')dimensions.push(human(matchType.toLowerCase()));
      const periods=arr(row?.granularMetrics),hasTotals=object(row?.totalMetrics);
      const breakdown=periods.length?'<details class="apple-report-periods"'+(!hasTotals?' open':'')+'><summary>'+periods.length+' reported period'+(periods.length===1?'':'s')+'</summary>'+periods.slice(0,100).map(period=>'<div class="apple-report-period"><strong>'+esc(typeof period?.date==='string'?period.date:'Date unavailable')+'</strong>'+appleReportMetrics(period)+'</div>').join('')+(periods.length>100?'<p class="operation-note">Showing 100 periods. All returned periods are in Details.</p>':'')+'</details>':'';
      return '<article class="record-row"><div class="record-heading"><strong>'+esc(name)+'</strong>'+(status?'<span>'+esc(human(status.toLowerCase()))+'</span>':'')+'</div>'+(dimensions.length?'<p class="apple-report-dimensions">'+dimensions.map(esc).join(' · ')+'</p>':'')+(hasTotals||!periods.length?appleReportMetrics(row?.totalMetrics):'')+breakdown+'</article>';
    }
    function renderAppleReport(data,meta) {
      const payload=recordPayload(data),hasRows=object(payload)&&Array.isArray(payload.rows),rows=hasRows?payload.rows:[];
      const content=hasRows?(rows.length?rows.slice(0,1000).map(appleReportRow).join(''):'<p class="operation-note">No report rows returned.</p>'):'<p class="operation-note">Report rows unavailable. The response is in Details.</p>';
      const grandTotal=payload?.summary?.grandTotal;
      // Use Apple's explicit total, which can cover more rows than this page.
      // Never sum breakdowns, average CPIs, or mix currencies in the widget.
      const summary=object(grandTotal)?'<div class="apple-report-total"><strong>Report total</strong>'+appleReportMetrics(grandTotal)+'</div>':'';
      const pagination=data.pagination,offset=pagination?.offset,count=pagination?.totalCount;
      const page=rows.length&&Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(count)&&count>=offset+rows.length?'<p class="apple-report-page">Showing '+(offset+1)+'–'+(offset+Math.min(rows.length,1000))+' of '+count+' results</p>':'';
      const clean={...data};delete clean._adport;
      app.innerHTML=chrome(operationHeader('Performance','', 'apple')+notices(data)+'<div class="record-list" data-apple-report role="region" aria-label="Apple performance results" tabindex="0">'+content+'</div>'+summary+page+(rows.length>1000?'<p class="operation-note">Showing 1,000 returned rows. The full response is in Details.</p>':'')+'<details><summary>Details</summary><pre>'+esc(JSON.stringify(clean,null,2))+'</pre></details>','Apple Ads');
    }
`;
