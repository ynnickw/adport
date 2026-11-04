export const INSIGHT_UI_STYLES = String.raw`
    .insight-list { display:grid; max-height:430px; overflow:auto; scrollbar-width:thin }
    .insight { padding:12px 0; border-bottom:1px solid var(--line); min-width:0 }
    .insight-heading { display:flex; align-items:center; gap:8px; min-width:0 }
    .insight-heading .logo { width:23px; height:23px; padding:4px; flex-shrink:0 }
    .insight-heading strong { flex:1; font-size:12px; line-height:1.5; overflow-wrap:anywhere }
    .insight p { margin:7px 0 0; font-size:12px; line-height:1.55; overflow-wrap:anywhere }
    .insight-reason { color:var(--muted) }
    .insight-action span { color:var(--muted); margin-right:5px }
`;

export const INSIGHT_UI_SCRIPT = String.raw`
    function renderInsights(data) {
      const items=data.finding?[data.finding]:arr(data.findings||data.recommendations||data.results||data.entries);
      const body=notices(data)+(items.length?'<div class="insight-list" role="region" aria-label="Recommendations" tabindex="0">'+items.map(item=>{
        const reason=typeof item.detail==='string'?item.detail:typeof item.description==='string'?item.description:'';
        const suggestion=typeof item.recommendation==='string'?item.recommendation:'';
        const status=item.status&&item.status!=='open'?item.status:item.severity||item.status||'';
        return '<article class="insight"><div class="insight-heading">'+(item.provider?logo(item.provider):'')+'<strong>'+esc(item.title||item.summary||item.rule||'Finding')+'</strong>'+(status?'<span class="pill '+(/critical|high/i.test(status)?'danger':'neutral')+'">'+esc(status)+'</span>':'')+'</div>'+(reason?'<p class="insight-reason">'+esc(reason)+'</p>':'')+(suggestion?'<p class="insight-action"><span>Suggested</span>'+esc(suggestion)+'</p>':'')+'</article>';
      }).join('')+'</div><details><summary>Details · '+items.length+' findings</summary><pre>'+esc(JSON.stringify(items,null,2))+'</pre></details>':'<div class="empty">No recommendations were returned.</div>');
      app.innerHTML=chrome(body,items.length+' recommendation'+(items.length===1?'':'s'));
    }
`;
