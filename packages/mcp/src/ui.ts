export const ADPORT_UI_URI = 'ui://adport/insight-card-v1.html';
export const ADPORT_UI_DOMAIN = 'https://app.adport.dev';

export type AdportView = 'accounts' | 'report' | 'operation' | 'insights';

const providerNames: Record<string, string> = {
  google: 'Google Ads',
  meta: 'Meta Ads',
  tiktok: 'TikTok Ads',
  apple: 'Apple Ads',
  microsoft: 'Microsoft Advertising',
  reddit: 'Reddit Ads',
  snapchat: 'Snapchat Ads',
  spotify: 'Spotify Ads',
  pinterest: 'Pinterest Ads',
  linkedin: 'LinkedIn Ads',
  x: 'X Ads',
  mock: 'Demo',
};

export function viewForTool(name: string, readOnly: boolean): AdportView | undefined {
  if (name === 'accounts_list') return 'accounts';
  if (name === 'report') return 'report';
  if (name === 'audit_run' || name === 'recommendation_dismiss') return 'insights';
  if (!readOnly) return 'operation';
  if (name.startsWith('recommendation') || name.startsWith('audit_')) return 'insights';
  return undefined;
}

export function toolTitle(name: string): string {
  if (name === 'accounts_list') return 'Show connected ad accounts';
  if (name === 'report') return 'Show advertising performance';
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function toolInvocationLabels(view: AdportView): { invoking: string; invoked: string } {
  switch (view) {
    case 'accounts': return { invoking: 'Loading ad accounts…', invoked: 'Ad accounts ready' };
    case 'report': return { invoking: 'Analyzing performance…', invoked: 'Performance ready' };
    case 'operation': return { invoking: 'Checking the proposed change…', invoked: 'Change preview ready' };
    case 'insights': return { invoking: 'Reviewing opportunities…', invoked: 'Opportunities ready' };
  }
}

export function structuredResult(tool: string, view: AdportView, result: unknown): Record<string, unknown> {
  const payload = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : { value: result };
  return {
    ...payload,
    _adport: {
      tool,
      view,
      providerNames,
    },
  };
}

/**
 * Self-contained MCP App. It uses the open MCP Apps postMessage protocol and
 * has no network dependencies, which keeps its review CSP intentionally empty.
 */
export const ADPORT_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Adport insight</title>
  <style>
    :root {
      --ink: var(--color-text-primary, #171717);
      --muted: var(--color-text-secondary, #6f6f73);
      --faint: var(--color-text-tertiary, #949499);
      --paper: var(--color-background-primary, #ffffff);
      --soft: var(--color-background-secondary, #f6f6f4);
      --line: var(--color-border-secondary, rgba(23,23,23,.11));
      --orange: #ff5a1f;
      --green: #16845b;
      --red: #c8392f;
      --amber: #a86500;
      --radius: var(--border-radius-lg, 18px);
      --sans: var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    }
    * { box-sizing: border-box }
    html, body { margin: 0; min-width: 0; background: transparent; color: var(--ink); font-family: var(--sans) }
    body { padding: 2px; }
    button { font: inherit }
    .shell { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); box-shadow: 0 10px 32px rgba(20,20,20,.07) }
    .top { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 16px 10px }
    .brand { display:flex; align-items:center; gap:9px; min-width:0 }
    .dot { width:10px; height:10px; border-radius:99px; background:var(--orange); box-shadow:0 0 0 5px color-mix(in srgb,var(--orange) 12%,transparent) }
    .brand b { font-size:12px; letter-spacing:-.02em }
    .context { color:var(--muted); font-size:11px; text-align:right }
    .content { padding:4px 16px 16px }
    .kpis { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin-bottom:15px }
    .kpi { min-width:0; padding:12px; border-radius:13px; background:var(--soft); border:1px solid color-mix(in srgb,var(--line) 70%,transparent) }
    button.kpi { cursor:pointer; color:var(--ink); text-align:left }
    button.kpi[aria-pressed="true"] { border-color:color-mix(in srgb,var(--orange) 65%,var(--line)) }
    .kpi small { display:block; color:var(--faint); font:600 9px/1.2 var(--mono); letter-spacing:.11em; text-transform:uppercase }
    .kpi strong { display:block; overflow:hidden; margin-top:8px; font-size:clamp(17px,3vw,24px); line-height:1; letter-spacing:-.04em; text-overflow:ellipsis }
    .panel { min-width:0; padding:13px; border:1px solid var(--line); border-radius:14px }
    .panel-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px }
    .panel-head b { font-size:12px }
    .panel-head span { color:var(--faint); font:500 9px/1 var(--mono); text-transform:uppercase; letter-spacing:.1em }
    .bars { display:grid; gap:9px }
    .bar-row { display:grid; grid-template-columns:minmax(100px,1fr) minmax(60px,2fr) auto; align-items:center; gap:9px; font-size:11px }
    .bar-name { display:flex; align-items:center; gap:7px; min-width:0 }
    .bar-name > span:last-child { overflow:hidden; white-space:nowrap; text-overflow:ellipsis }
    .bar-name .logo { width:22px; height:22px; padding:4px; border-radius:6px }
    .track { height:7px; overflow:hidden; border-radius:99px; background:var(--soft) }
    .fill { height:100%; border-radius:99px; background:linear-gradient(90deg,var(--orange),#ff985e) }
    .tabs { display:flex; gap:6px; overflow:auto; padding-bottom:12px }
    .tabs button { flex:0 0 auto; cursor:pointer; padding:8px 12px; border:1px solid var(--line); border-radius:99px; background:var(--paper); color:var(--muted); font-size:12px }
    .tabs button[aria-pressed="true"] { color:var(--ink); border-color:var(--orange); background:color-mix(in srgb,var(--orange) 8%,var(--paper)) }
    button:focus-visible { outline:2px solid var(--orange); outline-offset:2px }
    .notice { padding:10px 12px; margin:0 0 12px; border-radius:10px; background:var(--soft); color:var(--muted); font-size:12px; line-height:1.45 }
    .bar-value { color:var(--muted); font:600 10px/1 var(--mono); white-space:nowrap }
    .list { display:grid; gap:7px }
    .row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 11px; border:1px solid var(--line); border-radius:12px }
    .identity { display:flex; align-items:center; gap:10px; min-width:0 }
    .logo { display:grid; place-items:center; flex:0 0 auto; width:29px; height:29px; padding:6px; border:1px solid var(--line); border-radius:9px; color:var(--ink); background:var(--paper); font-weight:800; font-size:10px }
    .logo svg { display:block; width:100%; height:100% }
    .logo.reddit { background:#ff4500 }.logo.linkedin { background:#0a66c2 }.logo.spotify { background:#1db954 }.logo.pinterest { background:#e60023 }.logo.x { background:#111 }.logo.snapchat { background:#fffc00;color:#111 }
    .identity-copy { min-width:0 }
    .identity-copy b, .identity-copy span { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis }
    .identity-copy b { font-size:12px }.identity-copy span { margin-top:3px; color:var(--muted); font-size:10px }
    .pill { flex:0 0 auto; padding:5px 8px; border-radius:99px; color:var(--green); background:color-mix(in srgb,var(--green) 10%,transparent); font:700 9px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase }
    .pill.warn { color:var(--amber); background:color-mix(in srgb,var(--amber) 11%,transparent) }
    .pill.danger { color:var(--red); background:color-mix(in srgb,var(--red) 10%,transparent) }
    .pill.neutral { color:var(--muted); background:var(--soft) }
    .change { display:grid; gap:9px }
    .change-main { padding:14px; border-radius:14px; background:linear-gradient(135deg,color-mix(in srgb,var(--orange) 11%,var(--soft)),var(--soft)) }
    .change-main h2 { margin:0; font-size:17px; letter-spacing:-.025em }.change-main p { margin:6px 0 0; color:var(--muted); font-size:12px; line-height:1.45 }
    .checks { display:grid; gap:7px }
    .check { display:flex; gap:9px; align-items:flex-start; font-size:11px; line-height:1.4 }
    .check i { display:grid; place-items:center; flex:0 0 auto; width:17px; height:17px; border-radius:99px; background:color-mix(in srgb,var(--green) 11%,transparent); color:var(--green); font-style:normal; font-size:10px }
    .check.coerce i { color:var(--amber); background:color-mix(in srgb,var(--amber) 12%,transparent) }
    .empty { padding:26px 12px; text-align:center; color:var(--muted); font-size:12px }
    @media (max-width:620px) { .kpis { grid-template-columns:repeat(2,minmax(0,1fr)) }.top,.content { padding-left:12px; padding-right:12px } }
    @media (max-width:420px) { .bar-row { grid-template-columns:minmax(0,1fr) auto; gap:5px }.bar-name { grid-column:1/-1 }.bar-name > span:last-child { white-space:normal }.bars { gap:12px } }
    @media (prefers-reduced-motion:reduce) { * { animation:none!important; transition:none!important } }
    :root[data-theme="dark"] { --ink:#f5f5f3;--muted:#aaa9ad;--faint:#a09fa5;--paper:#171717;--soft:#222220;--line:rgba(255,255,255,.11) }
    @media (prefers-color-scheme:dark) { :root:not([data-theme="light"]) { --ink:#f5f5f3;--muted:#aaa9ad;--faint:#a09fa5;--paper:#171717;--soft:#222220;--line:rgba(255,255,255,.11) } }
  </style>
</head>
<body>
  <main id="app" class="shell" aria-live="polite">
    <header class="top"><div class="brand"><span class="dot"></span><b>adport.dev</b></div></header>
    <section class="content"><div class="empty">Loading…</div></section>
  </main>
  <script>
  (() => {
    const app = document.getElementById('app');
    const state = { host: {}, result: null, reportGroup: null, reportMetric: 'spend' };
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const arr = (value) => Array.isArray(value) ? value : [];
    const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
    const money = (value, currency) => currency
      ? new Intl.NumberFormat(state.host.locale || 'en', { style:'currency', currency, maximumFractionDigits:2 }).format(num(value))
      : new Intl.NumberFormat(state.host.locale || 'en', { maximumFractionDigits:2 }).format(num(value));
    const compact = (value) => new Intl.NumberFormat(state.host.locale || 'en', { notation:'compact', maximumFractionDigits:1 }).format(num(value));
    const available = (value) => typeof value === 'number' && Number.isFinite(value);
    const total = (rows, key) => rows.length && rows.every(r => available(r.metrics?.[key])) ? rows.reduce((sum,r) => sum+r.metrics[key],0) : null;
    const currencyOf = (row) => typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null;
    const statusOf = (status) => !status || /unknown|unspecified/i.test(status) ? {label:'Status unavailable',tone:'neutral'} : /disabled|removed|inactive|closed|suspended/i.test(status) ? {label:status,tone:'danger'} : /paused|disable$/i.test(status) ? {label:status,tone:'warn'} : /^(enabled|active|approved)$/i.test(status) ? {label:status,tone:''} : {label:status,tone:'neutral'};
    const notices = (data) => [...arr(data.errors).map(e => (e.provider || 'Provider')+': '+(e.message || 'Read failed')), ...arr(data.warnings).map(e => e.message || 'Some metadata is unavailable'), ...(data.truncated ? ['Partial result: row limit reached. Totals and charts cover returned rows only.'] : [])].map(text => '<p class="notice">'+esc(text)+'</p>').join('');
    const providerName = (id, names) => names?.[id] || String(id || 'Provider');
    const initials = (id) => ({snapchat:'S',spotify:'S',pinterest:'P',linkedin:'in',x:'X'}[id] || String(id || '?').slice(0,2).toUpperCase());
    const providerSvg = {
      google:'<svg viewBox="0 0 24 24"><path fill="#34a853" d="M4 22.93a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z"/><path fill="#4285f4" d="M23.464 16.929 15.463 3.072A4 4 0 0 0 8.534 7.072l8.001 13.857a4 4 0 0 0 6.929-4Z"/><path fill="#fbbc04" d="M7.514 4.844 1.565 15.148A4.5 4.5 0 0 1 4 14.43a4.5 4.5 0 0 1 4.494 4.715l3.217-5.573-3.61-6.25a4 4 0 0 1-.587-2.478Z"/></svg>',
      meta:'<svg viewBox="0 0 24 24"><path fill="#0866ff" d="M6.915 4.03C2.484 4.03 0 9.95 0 14.449c0 3.37 1.276 5.521 4.439 5.521 2.93 0 4.146-2.574 6.628-6.764l.942-1.664 2.335 3.895c1.883 3.15 3.38 4.533 5.53 4.533 2.788 0 4.126-1.93 4.126-5.56 0-5.53-2.73-10.38-6.8-10.38-2.04 0-3.835 1.53-5.173 3.348C10.16 5.01 8.593 4.03 6.915 4.03Zm-.04 2.606c1.55 0 2.445 1.193 3.908 3.025l-1.02 1.566c-2.22 3.41-3.576 6.155-5.323 6.155-1.23 0-2.154-1.075-2.154-2.9 0-3.755 2.088-7.846 4.588-7.846Zm10.2-.553c2.488 0 4.639 4.054 4.639 8.4 0 1.547-.368 2.899-1.839 2.899-1.193 0-2.027-1.42-4.496-5.362l-1.872-3.008c1.12-1.814 2.248-2.929 3.559-2.929Z"/></svg>',
      tiktok:'<svg viewBox="0 0 58 58"><path fill="#2dccd3" d="M25.98 0v37.68c0 4.94-3.55 8.11-7.88 8.11-1.43 0-2.79-.33-3.97-.95 1.5 1.91 3.87 3.01 6.47 3.01 4.32 0 7.87-3.17 7.87-8.11V2.06h6.85A20.3 20.3 0 0 1 34.87 0h-8.89Z"/><path fill="#f1204a" d="M41.73 11.11a17.48 17.48 0 0 1-4.37-9.05h-2.04c1.16 4.23 3.56 7.18 6.41 9.05Zm7.63 11.37a19.31 19.31 0 0 1-11-2.97c3.84 3.84 8.5 5.03 13.5 5.03v-8.82a17.4 17.4 0 0 1-2.5-.37v7.13Z"/><path fill="currentColor" d="M35.32 2.06h-6.85v37.68c0 4.94-3.55 8.11-7.87 8.11-2.6 0-4.97-1.1-6.47-3.01-2.48-1.29-4.19-3.82-4.19-7.16 0-5.71 4.47-8.71 10.42-8.09v-7.68C10.63 21.93 2.49 29.73 2.49 39.4c0 5.16 2.04 9.71 5.32 12.96 2.89 1.97 6.39 3.11 10.15 3.11 8.69 0 17.91-6.38 17.91-18.41V17.45c.8.8 1.63 1.48 2.49 2.06a19.31 19.31 0 0 0 11 2.97v-7.13a16.14 16.14 0 0 1-7.63-4.24c-2.85-1.87-5.25-4.82-6.41-9.05Z"/></svg>',
      apple:'<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09Zm3.377-3.065C16.372 2.819 16.929 1.403 16.774 0c-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.56-1.701Z"/></svg>',
      microsoft:'<svg viewBox="0 0 24 24"><path fill="#f25022" d="M0 0h11.4v11.4H0Z"/><path fill="#7fba00" d="M12.6 0H24v11.4H12.6Z"/><path fill="#00a4ef" d="M0 12.6h11.4V24H0Z"/><path fill="#ffb900" d="M12.6 12.6H24V24H12.6Z"/></svg>',
      reddit:'<svg viewBox="0 0 24 24"><path fill="#ff4500" d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0Zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614.028.169.042.342.042.52 0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .378-.239l2.906.617a1.214 1.214 0 0 1 1.108-.701Z"/></svg>'
    };
    const logo = (id) => '<span class="logo '+esc(id)+'" aria-hidden="true">'+(providerSvg[id] || esc(initials(id)))+'</span>';
    const chrome = (body, context) => '<header class="top"><div class="brand"><span class="dot"></span><b>adport.dev</b></div><span class="context">'+esc(context || '')+'</span></header><section class="content">'+body+'</section>';
    function renderAccounts(data, meta) {
      const accounts = arr(data.accounts), errors = arr(data.errors), names = meta.providerNames || {};
      const body = notices(data)+(accounts.length ? '<div class="list">'+accounts.map(a => { const status=statusOf(a.status); return '<div class="row"><div class="identity">'+logo(a.provider)+'<div class="identity-copy"><b>'+esc(a.name || 'Ad account')+'</b><span>'+esc(providerName(a.provider,names))+' · '+esc(a.id)+(a.currency ? ' · '+esc(a.currency) : '')+'</span></div></div><span class="pill '+status.tone+'">'+esc(status.label)+'</span></div>'; }).join('')+'</div>' : '<div class="empty">'+(errors.length ? 'Account inventory could not be fully loaded.' : 'No accessible ad accounts were returned.')+'</div>');
      app.innerHTML = chrome(body, accounts.length+' account'+(accounts.length===1?'':'s'));
    }
    function renderReport(data) {
      const groups = new Map();
      for (const row of arr(data.rows)) {
        const currency=currencyOf(row), key=currency || JSON.stringify([row.provider,row.accountId]);
        if (!groups.has(key)) groups.set(key,{key,currency,label:currency || (row.provider+' · '+row.accountId),rows:[]});
        groups.get(key).rows.push(row);
      }
      const choices=[...groups.values()];
      const selected=groups.get(state.reportGroup) || choices[0];
      const rows=selected?.rows || [], currency=selected?.currency;
      state.reportGroup=selected?.key;
      const tabs=choices.length>1 ? '<div class="tabs" role="group" aria-label="Report currency or account">'+choices.map((g,i)=>'<button data-group="'+i+'" aria-pressed="'+(g===selected)+'">'+esc(g.label)+'</button>').join('')+'</div>' : '';
      const spend=total(rows,'spend'), value=total(rows,'conversion_value');
      const roas=spend>0 && value!==null ? (value/spend).toFixed(2)+'×' : '—';
      const metric=state.reportMetric, labels={spend:'Spend',clicks:'Clicks',conversions:'Conversions',roas:'ROAS'};
      const metricValue=r=>metric==='roas' ? (available(r.metrics?.conversion_value) && r.metrics?.spend>0 ? r.metrics.conversion_value/r.metrics.spend : null) : r.metrics?.[metric];
      const format=value=>metric==='spend'?money(value,currency):metric==='roas'?value.toFixed(2)+'×':compact(value);
      const ranked=[...rows].filter(r=>available(metricValue(r))).sort((a,b)=>metricValue(b)-metricValue(a)).slice(0,6), max=Math.max(1,...ranked.map(metricValue));
      const bars=ranked.length ? ranked.map(r=>'<div class="bar-row"><span class="bar-name" title="'+esc(r.entity?.name || r.entity?.id)+'">'+logo(r.provider)+'<span>'+esc(r.entity?.name || r.entity?.id || 'Entity')+'</span></span><span class="track" aria-hidden="true"><span class="fill" style="display:block;width:'+Math.max(0,metricValue(r)/max*100).toFixed(1)+'%"></span></span><span class="bar-value">'+esc(format(metricValue(r)))+'</span></div>').join('') : '<div class="empty">No '+esc(labels[metric])+' values were returned.</div>';
      const kpi=(key,label,value)=>'<button class="kpi" data-metric="'+key+'" aria-pressed="'+(metric===key)+'" aria-label="Chart '+esc(label)+'"><small>'+esc(label)+'</small><strong>'+esc(value)+'</strong></button>';
      const period=typeof data.date_range==='string' ? data.date_range.replaceAll('_',' ') : data.date_range ? data.date_range.start+' – '+data.date_range.end : 'Selected period';
      const body=notices(data)+tabs+(rows.length ? (!currency?'<p class="notice">Currency unavailable. These values belong to this account only; no cross-account money total is calculated.</p>':'')+'<div class="kpis" role="group" aria-label="Chart metric">'+kpi('spend','Spend',spend===null?'—':money(spend,currency))+kpi('clicks','Clicks',total(rows,'clicks')===null?'—':compact(total(rows,'clicks')))+kpi('conversions','Conversions',total(rows,'conversions')===null?'—':compact(total(rows,'conversions')))+kpi('roas','ROAS',roas)+'</div><div class="panel"><div class="panel-head"><b>'+esc(labels[metric])+'</b><span>Top '+ranked.length+' of '+rows.length+' rows</span></div><div class="bars">'+bars+'</div></div>' : '<div class="empty">'+(arr(data.errors).length?'Report unavailable for the requested providers.':'No rows returned for this period.')+'</div>');
      app.innerHTML=chrome(body,period+(currency?' · '+currency:''));
      app.querySelectorAll('[data-group]').forEach(button=>button.addEventListener('click',()=>{state.reportGroup=choices[Number(button.dataset.group)].key;renderReport(data);}));
      app.querySelectorAll('[data-metric]').forEach(button=>button.addEventListener('click',()=>{state.reportMetric=button.dataset.metric;renderReport(data);}));
    }
    function renderOperation(data, meta) {
      if (meta.tool === 'recommendation_apply' && data.result) data = data.result;
      const preview = data.preview || {}, pending = data.pending_operation_id, applied = data.status === 'applied' || data.applied === true;
      const changes = arr(preview.changes), coercions = arr(preview.coercions), deltas = arr(preview.budgetDeltas);
      const checks = [...changes.map(v=>({v,kind:''})),...coercions.map(v=>({v,kind:'coerce'})),...deltas.map(v=>({v:(v.target || 'Budget')+': '+(v.fromMicros == null ? 'new' : money(v.fromMicros/1e6))+' → '+money(num(v.toMicros)/1e6),kind:'coerce'}))];
      const validation=preview.serverValidated===true?'server validated':preview.serverValidated===false?'local preview · not server validated':'validation not reported';
      const body = '<div class="change"><div class="change-main"><div class="panel-head"><b>'+(applied?'Applied':pending?'Policy-gated preview':'Result')+'</b><span>'+esc(validation)+'</span></div><h2>'+esc(preview.summary || (applied ? 'The requested operation completed.' : 'Review the operation result.'))+'</h2><p>'+(pending ? 'Nothing has been changed yet. Applying requires the matching pending operation token before it expires.' : applied ? 'The result is recorded in the append-only audit log.' : 'Review the structured result in the conversation for full details.')+'</p></div><div class="checks">'+(checks.length ? checks.map(item=>'<div class="check '+item.kind+'"><i>'+(item.kind?'!':'✓')+'</i><span>'+esc(item.v)+'</span></div>').join('') : '<div class="empty">No additional change details were returned.</div>')+'</div></div>';
      app.innerHTML = chrome(body, meta.tool || 'Operation');
    }
    function renderInsights(data) {
      const items = data.finding ? [data.finding] : arr(data.findings || data.recommendations || data.results || data.entries);
      const body = items.length ? '<div class="list">'+items.slice(0,8).map((item,i)=>'<div class="row"><div class="identity"><span class="logo" style="background:var(--orange)">'+(i+1)+'</span><div class="identity-copy"><b>'+esc(item.title || item.summary || item.rule || 'Opportunity')+'</b><span>'+esc(item.description || item.status || item.severity || 'Review recommended')+'</span></div></div><span class="pill '+(/high|critical/i.test(item.severity || '')?'danger':'')+'">'+esc(item.severity || item.status || 'open')+'</span></div>').join('')+'</div>' : '<div class="empty">No active recommendations were returned.</div>';
      app.innerHTML = chrome(body, items.length+' recommendation'+(items.length===1?'':'s'));
    }
    function render(result) {
      let data = result?.structuredContent || result || {};
      if (!data._adport && window.openai?.toolOutput?._adport) data=window.openai.toolOutput;
      const meta = data._adport || {};
      if (result?.isError || data.error) {
        app.innerHTML=chrome('<p class="notice">'+esc(data.message || 'The request could not complete. See the tool response for details.')+'</p>','Request failed');
        return;
      }
      if (meta.view === 'accounts') return renderAccounts(data,meta);
      if (meta.view === 'report') return renderReport(data,meta);
      if (meta.view === 'operation') return renderOperation(data,meta);
      return renderInsights(data,meta);
    }
    const send = (message) => window.parent.postMessage(message,'*');
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      send({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:Math.ceil(document.body.getBoundingClientRect().height)}});
    });
    let id = 1;
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== '2.0') return;
      if (message.id === 1 && message.result) {
        state.host = message.result.hostContext || {};
        document.documentElement.dataset.theme = state.host.theme || '';
        send({jsonrpc:'2.0',method:'ui/notifications/initialized'});
        resize?.observe(document.body);
        if (state.result) render(state.result);
      }
      if (message.method === 'ui/notifications/tool-result') { state.result = message.params; render(message.params); }
      if (message.method === 'ui/notifications/host-context-changed') { state.host = {...state.host,...message.params}; document.documentElement.dataset.theme = state.host.theme || ''; if(state.result) render(state.result); }
    });
    send({jsonrpc:'2.0',id:id++,method:'ui/initialize',params:{appInfo:{name:'Adport Insight',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'}});
    if (window.openai?.toolOutput) render({structuredContent:window.openai.toolOutput});
  })();
  </script>
</body>
</html>`;
