export const MEDIA_LIBRARY_STYLES = String.raw`
    .media-library { position:relative }
    .media-toolbar,.widget-upload-actions { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px }
    .media-toolbar h2 { margin:0; font-size:13px; font-weight:600; letter-spacing:-.015em }
    .media-toolbar small { color:var(--muted); font-size:11px; font-weight:400; margin-left:7px }
    .media-button { display:inline-flex; align-items:center; justify-content:center; gap:5px; min-height:34px; padding:7px 12px; border:1px solid var(--line); border-radius:999px; background:var(--paper); color:var(--ink); font-size:12px; cursor:pointer; flex-shrink:0 }
    .media-button.primary { border-color:transparent; background:var(--orange); color:#171717; font-weight:600 }
    .media-button:active { opacity:.75 }
    .media-button:disabled,.media-button[aria-disabled="true"] { opacity:.5; cursor:default }
    .media-file-label { position:relative; overflow:hidden }
    .media-file-label:focus-within { outline:2px solid var(--orange); outline-offset:2px }
    .media-file-label input { position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer }
    .media-library.dragging::after { content:'Drop files to upload'; position:absolute; inset:0; z-index:2; display:grid; place-items:center; border:2px dashed var(--orange); border-radius:12px; background:var(--paper); color:var(--ink); font-size:14px; pointer-events:none }
    .widget-upload-queue { display:grid; gap:8px; max-height:220px; overflow:auto; margin-bottom:10px; scrollbar-width:thin }
    .widget-upload-row { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:4px 9px; align-items:center; padding:8px 10px; background:var(--soft); border-radius:9px }
    .widget-upload-row strong { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:11px; font-weight:500 }
    .widget-upload-row small,.widget-upload-status { color:var(--muted); font-size:10px }
    .widget-upload-row progress { grid-column:1/-1; width:100%; height:4px; accent-color:var(--orange) }
    .widget-upload-row p { grid-column:1/-1; margin:2px 0; color:var(--red); font-size:11px; line-height:1.4; overflow-wrap:anywhere }
    .widget-upload-row .media-button { min-height:28px; padding:4px 8px; font-size:10px }
    .widget-upload-actions { justify-content:flex-end; margin-top:6px }
    .widget-upload-summary { margin-right:auto; color:var(--muted); font-size:11px }
    .media-pages { display:flex; justify-content:center; margin-top:10px }
    .media-message { margin:8px 0; color:var(--muted); font-size:11px; line-height:1.4 }
    @media (pointer:coarse) { .media-button,.widget-upload-row .media-button { min-height:44px } }
`;

/** Central library only. Pagination and queue updates retain existing media nodes. */
export const MEDIA_LIBRARY_UI = String.raw`
    let mediaLibrary=null;
    const libraryPreviewReads=new Map();
    function mediaLibraryProject(data,meta) {
      const project=meta.context?.project_id || data.upload_config?.project_id;
      return uploadUuid(project) && (!data.upload_config?.project_id || data.upload_config.project_id===project)?project:null;
    }
    function libraryFilterKey(meta) {
      const args={...meta.refresh?.arguments};delete args.cursor;delete args.pending_operation_id;
      return JSON.stringify(Object.keys(args).sort().map(key=>[key,args[key]]));
    }
    function mediaUploadMarkup(context) {
      if(!context) return '';
      return '<label class="media-button primary media-file-label" title="Choose, drop or paste files">Upload files<input type="file" multiple data-upload-files aria-label="Upload files" accept="'+esc(context.config.content_types.join(','))+'"></label>';
    }
    function renderMediaLibrary(data,meta) {
      const project=mediaLibraryProject(data,meta),key=libraryFilterKey(meta);
      const retain=mediaLibrary?.project===project && mediaLibrary.key===key && app.querySelector('[data-media-gallery]');
      mediaLibrary={project,key,data,meta,loading:false,seen:retain?mediaLibrary.seen:new Set(),previews:retain?mediaLibrary.previews:new Map()};
      if(!retain) app.innerHTML=chrome('<div class="media-library" data-upload-drop><div class="media-toolbar"><h2>Media library<small data-library-count></small></h2><div data-upload-picker></div></div><section data-upload-panel aria-label="Upload queue"></section><div data-library-notes></div><div class="creative-grid" data-media-gallery role="region" aria-label="Creative previews" tabindex="0"></div><div data-library-pages></div></div>','');
      app.querySelector('[data-library-count]').textContent=arr(data.creatives).length+' files';
      app.querySelector('[data-upload-picker]').innerHTML=mediaUploadMarkup(uploadContext(data,meta));
      app.querySelector('[data-library-notes]').innerHTML=notices({...data,truncated:false});
      const gallery=app.querySelector('[data-media-gallery]'),existing=new Map([...gallery.querySelectorAll('article')].map(card=>[card.dataset.mediaId,card]));
      const template=document.createElement('template');template.innerHTML=creativeCards(arr(data.creatives));
      const keep=new Set();
      for(const card of [...template.content.children]) {
        const old=existing.get(card.dataset.mediaId);keep.add(card.dataset.mediaId);
        if(old) {
          // Signed URLs renew independently; keep healthy players and their playback state.
          for(const selector of ['.creative-heading','.creative-copy','.creative-footer']) old.querySelector(selector)?.replaceChildren(...card.querySelector(selector).childNodes);
          if(!old.querySelector('img,video,audio') && !old.querySelector('[data-preview-retry]') && card.querySelector('.creative-media')) {const media=card.querySelector('.creative-media');if(old.querySelector('.creative-media')) old.querySelector('.creative-media').replaceWith(media);else old.querySelector('.creative-copy').before(media);bindLibraryPreviews(old);}
        } else {gallery.append(card);bindLibraryPreviews(card);}
      }
      for(const [id,card] of existing) if(!keep.has(id)) card.remove();
      gallery.querySelector('.empty')?.remove();
      if(!keep.size) gallery.innerHTML='<div class="empty">'+(uploadContext(data,meta)?'Drop files here or choose Upload files.':'No files to preview.')+'</div>';
      renderLibraryPages();uploadDraw();bindWidgetUpload(uploadContext(data,meta));
    }
    function bindLibraryPreviews(root) {bindCreativeErrors(root,recoverLibraryPreview);}
    function libraryPreviewActive(scope,card,asset) {
      const current=arr(mediaLibrary?.data.assets).find(item=>item.id===asset.id);
      return mediaLibrary?.previews===scope && app.contains(card) && current?.sha256===asset.sha256 && current.status==='READY';
    }
    function libraryPreviewMessage(card,entry,loading=false) {
      const item=card.querySelector('.creative-media-item');if(!item) return;
      const message=document.createElement('span');message.className='creative-placeholder';message.setAttribute('role','status');message.textContent=loading?'Refreshing preview…':'Preview unavailable';
      // An expired image's anchor must not remain an active stale download link.
      const holder=document.createElement('div');holder.className='creative-media-item';holder.append(message);item.replaceWith(holder);
      if(!loading) {const retry=document.createElement('button');retry.className='media-button';retry.type='button';retry.dataset.previewRetry='true';retry.textContent='Retry';retry.setAttribute('aria-label','Retry preview: '+entry.asset.name);retry.addEventListener('click',()=>renewLibraryPreview(card,entry));holder.append(retry);}
    }
    function recoverLibraryPreview(media) {
      const card=media.closest('article'),asset=arr(mediaLibrary?.data.assets).find(item=>item.id===card?.dataset.mediaId);
      if(!card || !uploadUuid(asset?.id) || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '') || asset.status!=='READY') return false;
      const scope=mediaLibrary.previews,key=asset.id+':'+asset.sha256;
      let entry=scope.get(key);
      if(!entry) {entry={asset,scope,project:mediaLibrary.project,pending:false};scope.set(key,entry);renewLibraryPreview(card,entry);}
      else libraryPreviewMessage(card,entry,entry.pending);
      return true;
    }
    async function renewLibraryPreview(card,entry) {
      const {asset,scope,project}=entry;if(entry.pending || !libraryPreviewActive(scope,card,asset)) return;
      entry.pending=true;libraryPreviewMessage(card,entry,true);
      libraryPreviewReads.set(project+':'+asset.id,entry);
      try {
        const response=await callTool('media_get',{media_id:asset.id,project_id:project},60000),value=resultData(response),fresh=value.asset;
        if(response?.isError || value.error || value._adport?.tool!=='media_get' || value._adport?.context?.project_id!==project || fresh?.id!==asset.id || fresh.sha256!==asset.sha256 || fresh.byte_length!==asset.byte_length || fresh.content_type!==asset.content_type || fresh.status!=='READY') throw new Error('Preview could not be confirmed.');
        if(!libraryPreviewActive(scope,card,asset)) return;
        const creative=arr(mediaLibrary.data.creatives).find(item=>item.id===asset.id),kind=fresh.content_type.split('/')[0];
        const media=fresh.preview_cover_url && fresh.preview_url?[{type:'image',url:fresh.preview_cover_url,open_url:fresh.preview_url,alt:creative.name+' — first page'}]:fresh.preview_url && ['image','video','audio'].includes(kind)?[{type:kind,url:fresh.preview_url,alt:creative.name}]:[];
        const updated={...creative,media},template=document.createElement('template');template.innerHTML=creativeCards([updated]);
        const preview=template.content.querySelector('.creative-media');if(!preview || !preview.querySelector('img,video,audio')) throw new Error('Preview unavailable.');
        card.querySelector('.creative-media').replaceWith(preview);bindLibraryPreviews(card);
        const data={...mediaLibrary.data,assets:arr(mediaLibrary.data.assets).map(item=>item.id===asset.id?fresh:item),creatives:arr(mediaLibrary.data.creatives).map(item=>item.id===asset.id?updated:item)};
        mediaLibrary.data=data;state.hasLocalResult=true;state.result={structuredContent:{...data,_adport:mediaLibrary.meta}};
      } catch {if(libraryPreviewActive(scope,card,asset)) libraryPreviewMessage(card,entry);}
      finally {
        entry.pending=false;
        // Keep every in-flight echo bound, even when a large page expires together.
        for(const [key,read] of libraryPreviewReads) {if(libraryPreviewReads.size<=32) break;if(!read.pending) libraryPreviewReads.delete(key);}
      }
    }
    function mediaLibraryIgnoreEcho(data) {
      return !!app.querySelector('[data-media-gallery]') && data?._adport?.tool==='media_get' && [...libraryPreviewReads.values()].some(entry=>data._adport.context?.project_id===entry.project && (entry.asset.id===data.asset?.id || entry.pending && !data.asset));
    }
    function renderLibraryPages(message='') {
      if(!mediaLibrary || !app.querySelector('[data-library-pages]')) return;
      const focused=app.querySelector('[data-library-more]')===document.activeElement;
      const {data,meta,loading}=mediaLibrary,next=meta.next?.arguments;
      app.querySelector('[data-library-pages]').innerHTML=(message?'<p class="media-message" role="status">'+esc(message)+'</p>':'')+(next?'<div class="media-pages"><button class="media-button" data-library-more aria-disabled="'+loading+'">'+(loading?'Loading…':'Load more')+'</button></div>':data.truncated?'<p class="media-message">More files may exist. Ask your assistant for the next page.</p>':'');
      const button=app.querySelector('[data-library-more]');button?.addEventListener('click',loadLibraryPage);
      if(focused) (button || app.querySelector('[data-media-gallery]'))?.focus({preventScroll:true});
    }
    async function loadLibraryPage() {
      const library=mediaLibrary;if(!library || library.loading || !library.meta.next?.arguments) return;
      const args={...library.meta.next.arguments,project_id:library.project};
      if(!uploadUuid(args.cursor) || library.seen.has(args.cursor)) {library.meta={...library.meta,next:undefined};renderLibraryPages('No new page was returned.');return;}
      library.loading=true;renderLibraryPages();
      try {
        const response=await callTool('media_list',args,60000),value=resultData(response);
        if(response?.isError || value.error || !Array.isArray(value.creatives) || value._adport?.tool!=='media_list' || mediaLibraryProject(value,value._adport)!==library.project) throw new Error('The next page could not be confirmed. Try Load more again.');
        if(mediaLibrary!==library) return;
        library.seen.add(args.cursor);
        const byId=new Map(arr(library.data.creatives).map(item=>[item.id,item]));
        for(const item of value.creatives) byId.set(item.id,item);
        const assets=new Map(arr(library.data.assets).map(item=>[item.id,item]));for(const item of arr(value.assets)) assets.set(item.id,item);
        const next=value._adport.next?.arguments;
        const meta={...library.meta,next:next && next.cursor!==args.cursor && !library.seen.has(next.cursor)?{arguments:next}:undefined};
        const data={...library.data,...value,assets:[...assets.values()],creatives:[...byId.values()],_adport:meta};
        acceptResult({structuredContent:data},true);
      } catch(error) {if(mediaLibrary===library) renderLibraryPages(error?.message || 'Could not load more files.');}
      finally {if(mediaLibrary===library) {library.loading=false;const more=app.querySelector('[data-library-more]');if(more) {more.setAttribute('aria-disabled','false');more.textContent='Load more';}}}
    }
    function showUploadedAsset(item,asset) {
      if(!mediaLibrary || mediaLibrary.project!==item.context.project) return;
      const args=mediaLibrary.meta.refresh?.arguments || {},kind=['application/pdf','text/csv'].includes(asset.content_type)?'document':asset.content_type.split('/')[0];
      if(args.kind && args.kind!==kind || args.query && !asset.name.toLowerCase().includes(args.query.toLowerCase()) || args.tag && !arr(asset.tags).includes(args.tag) || args.platform && !arr(asset.platforms).includes(args.platform)) return;
      const creative={id:asset.id,name:asset.name,provider:'media',type:asset.content_type,status:asset.status,headlines:[],descriptions:[uploadBytes(asset.byte_length)],media:asset.preview_cover_url && asset.preview_url?[{type:'image',url:asset.preview_cover_url,open_url:asset.preview_url,alt:asset.name+' — first page'}]:asset.preview_url && ['image','video','audio'].includes(kind)?[{type:kind,url:asset.preview_url,alt:asset.name}]:[]};
      const data={...mediaLibrary.data,creatives:[creative,...arr(mediaLibrary.data.creatives).filter(value=>value.id!==asset.id)],assets:[asset,...arr(mediaLibrary.data.assets).filter(value=>value.id!==asset.id)]};
      const gallery=app.querySelector('[data-media-gallery]'),template=document.createElement('template');template.innerHTML=creativeCards([creative]);
      gallery.querySelector('.empty')?.remove();
      const existing=[...gallery.querySelectorAll('article')].find(card=>card.dataset.mediaId===asset.id);
      if(!existing) {gallery.prepend(template.content);bindLibraryPreviews(gallery);}
      else if(!existing.querySelector('img,video,audio') && template.content.querySelector('.creative-media')) {existing.querySelector('.creative-media')?.remove();existing.querySelector('.creative-copy').before(template.content.querySelector('.creative-media'));bindLibraryPreviews(existing);}
      mediaLibrary.data=data;state.hasLocalResult=true;state.result={structuredContent:{...data,_adport:mediaLibrary.meta}};
      app.querySelector('[data-library-count]').textContent=data.creatives.length+' files';
    }
`;
