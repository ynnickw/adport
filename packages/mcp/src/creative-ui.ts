export const CREATIVE_UI_STYLES = String.raw`
    .shell:has(.creative-grid-single) { max-width:320px }
    .creative-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr)); gap:10px; max-height:430px; overflow:auto; overscroll-behavior:contain; align-items:start; scrollbar-width:thin }
    .creative-grid:focus-visible { outline:2px solid var(--orange); outline-offset:3px; border-radius:10px }
    .creative-grid-single { grid-template-columns:minmax(0,280px); max-height:none }
    .creative-card { min-width:0; padding:10px; border:1px solid var(--line); border-radius:12px }
    .creative-heading { display:flex; align-items:center; gap:6px; min-width:0; margin-bottom:8px }
    .creative-heading .logo { width:18px; height:18px; padding:2px; border:0; border-radius:4px; background:transparent }
    .creative-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; font-weight:600 }
    .creative-media { display:flex; overflow-x:auto; gap:6px; scroll-snap-type:x mandatory; scrollbar-width:thin; margin:0 0 8px; border-radius:7px; background:var(--soft) }
    .creative-media-item { display:grid; place-items:center; flex:0 0 100%; min-width:0; height:128px; scroll-snap-align:start; color:var(--muted); text-decoration:none }
    .creative-media img,.creative-media video { display:block; width:100%; height:128px; object-fit:contain }
    .creative-media audio { width:100%; max-width:100% }
    .creative-placeholder { color:var(--muted); font:500 10px/1.5 var(--sans) }
    .creative-copy { display:grid; gap:4px; overflow-wrap:anywhere }
    .creative-copy strong,.creative-copy p { display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden; margin:0; font-size:12px; line-height:1.45; white-space:pre-wrap }
    .creative-copy strong { -webkit-line-clamp:2; font-weight:600 }
    .creative-copy p { -webkit-line-clamp:3; color:var(--muted) }
    .creative-footer { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:8px; color:var(--muted); font-size:10px; line-height:1.4 }
    .creative-status { display:flex; align-items:center; gap:4px; white-space:nowrap }
    .creative-status::before { content:''; width:4px; height:4px; border-radius:50%; background:var(--faint) }
    .creative-status-active::before { background:var(--green) }
    .creative-destination { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); text-decoration:none }
    .creative-destination:hover { text-decoration:underline }
`;

/** Media rendering is shared; scoped controls live in the provider gallery or central library. */
export const CREATIVE_UI_SCRIPT = String.raw`
    function creativeCards(creatives,menuFor) {
      const safeUrl=(value,media=false)=>{try {const url=new URL(value);return (media?url.protocol==='https:':['https:','http:'].includes(url.protocol))&&!url.username&&!url.password?url:null;} catch {return null;}};
      const mediaView=creative=>{
        const items=arr(creative.media).map(media=>{
          const url=safeUrl(media.url,true);if (!url) return '';
          const src=esc(url.href),open=safeUrl(media.open_url,true)||url,poster=safeUrl(media.poster_url,true),name=esc(media.alt || creative.name || 'Creative');
          if (media.type==='image') return '<a class="creative-media-item" href="'+esc(open.href)+'" target="_blank" rel="noopener noreferrer" aria-label="'+(creative.type==='application/pdf'?'Open document: ':'View image: ')+name+'"><img src="'+src+'" alt="'+name+'" loading="lazy" referrerpolicy="no-referrer"></a>';
          if (media.type==='video') return '<div class="creative-media-item"><video src="'+src+'" data-open-url="'+esc(open.href)+'" controls preload="metadata" '+(poster?'poster="'+esc(poster.href)+'"':'data-first-frame')+' playsinline aria-label="'+name+'"></video></div>';
          if (media.type==='audio') return '<div class="creative-media-item"><audio src="'+src+'" data-open-url="'+esc(open.href)+'" controls preload="none" aria-label="'+name+'"></audio></div>';
          return '';
        }).join('');
        if (items) return '<div class="creative-media">'+items+'</div>';
        return /pdf|document/i.test(creative.type || '')?'<div class="creative-media"><div class="creative-media-item"><span class="creative-placeholder">Document preview unavailable</span></div></div>':'';
      };
      const unique=values=>[...new Set(arr(values).filter(value=>typeof value==='string'&&value.trim()))];
      return creatives.map(creative=>{
        const name=creative.name || 'Untitled creative',status=statusOf(creative.status);
        const destination=arr(creative.landing_urls).map(value=>safeUrl(value)).find(Boolean);
        const headline=unique(creative.headlines).filter(text=>text!==name).join(' · '),copy=unique(creative.descriptions).filter(text=>text!==name&&text!==headline).join('\n');
        const active=/^(active|enabled|ready|approved)$/i.test(creative.status || '');
        return '<article class="creative-card" data-media-id="'+esc(creative.id)+'"><div class="creative-heading">'+(providerSvg[creative.provider]?logo(creative.provider):'')+'<span class="creative-name" title="'+esc(name)+'">'+esc(name)+'</span>'+(menuFor?menuFor(creative):'')+'</div>'+mediaView(creative)+'<div class="creative-copy">'+(headline?'<strong title="'+esc(headline)+'">'+esc(headline)+'</strong>':'')+(copy?'<p title="'+esc(copy)+'">'+esc(copy)+'</p>':'')+'</div><div class="creative-footer"><span class="creative-status'+(active?' creative-status-active':'')+'">'+esc(status.label)+'</span>'+(destination?'<a class="creative-destination" href="'+esc(destination.href)+'" target="_blank" rel="noopener noreferrer">'+esc(destination.hostname.replace(/^www\./,''))+'</a>':'')+'</div></article>';
      }).join('');
    }
    function bindCreativeErrors(root,recover) {
      root.querySelectorAll('.creative-media img,.creative-media video,.creative-media audio').forEach(media=>{
        if(media.dataset.previewBound) return;media.dataset.previewBound='true';
        if(media.matches('video[data-first-frame]')) media.addEventListener('loadedmetadata',()=>{if(Number.isFinite(media.duration)&&media.duration>0)media.currentTime=Math.min(.1,media.duration/2);},{once:true});
        media.addEventListener('error',()=>{
          if(recover?.(media)) return;
          const item=media.closest('.creative-media-item');
          const openUrl=media.dataset.openUrl;
          const placeholder=document.createElement(openUrl?'a':'span');
          placeholder.className='creative-placeholder';
          placeholder.textContent=openUrl || item.matches('a[href]')?'Open preview':'Preview unavailable';
          if(openUrl){placeholder.href=openUrl;placeholder.target='_blank';placeholder.rel='noopener noreferrer';}
          item.replaceChildren(placeholder);
        },{once:true});
      });
    }
    function renderCreatives(data,meta) {
      if(meta.tool==='media_list' && mediaLibraryProject(data,meta)) return renderMediaLibrary(data,meta);
      return renderProviderGallery(data,meta);
    }
`;
