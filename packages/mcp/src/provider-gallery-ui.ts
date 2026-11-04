export const PROVIDER_GALLERY_STYLES = String.raw`
    .creative-heading .creative-name { flex:1 }
    .creative-menu { position:relative; margin-left:auto; flex:none }
    .creative-menu>summary { display:grid; place-items:center; width:30px; min-height:30px; border-radius:7px; cursor:pointer; list-style:none; font-size:17px; color:var(--muted) }
    .creative-menu>summary::-webkit-details-marker { display:none }
    .creative-menu>summary:hover,.creative-menu>summary:active { background:var(--soft); color:var(--ink) }
    .creative-menu>summary:focus-visible,.creative-menu button:focus-visible,.creative-editor input:focus-visible,.creative-editor textarea:focus-visible,.creative-editor select:focus-visible { outline:2px solid var(--orange); outline-offset:2px }
    .creative-menu-items { position:absolute; top:100%; right:0; z-index:3; width:max-content; max-width:210px; padding:4px; border:1px solid var(--line); border-radius:9px; background:var(--paper); box-shadow:0 6px 20px rgba(0,0,0,.12) }
    .creative-menu-items button { display:block; width:100%; min-height:32px; padding:6px 9px; border:0; border-radius:5px; background:none; color:var(--ink); font:inherit; font-size:11px; text-align:left; cursor:pointer }
    .creative-menu-items button:hover,.creative-menu-items button:active { background:var(--soft) }
    .creative-editor { display:grid; gap:8px; padding-top:10px; margin-top:10px; border-top:1px solid var(--line) }
    .creative-editor label { display:grid; gap:4px; color:var(--muted); font-size:11px }
    .creative-editor input,.creative-editor textarea,.creative-editor select { box-sizing:border-box; width:100%; min-width:0; padding:7px 8px; border:1px solid var(--line); border-radius:7px; background:var(--paper); color:var(--ink); font:12px/1.45 var(--sans) }
    .creative-editor textarea { resize:vertical; min-height:66px }
    .creative-editor-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px }
    .provider-pages { display:flex; justify-content:center; margin-top:10px }
    .provider-message { margin:8px 0; color:var(--muted); font-size:11px; line-height:1.4 }
    @media (pointer:coarse) { .creative-menu>summary,.creative-menu-items button { min-height:44px } }
`;

/** Provider controls invoke the registry; the central upload library remains separate. */
export const PROVIDER_GALLERY_UI = String.raw`
    let providerGallery=null;
    const galleryStable=value=>JSON.stringify((function sort(v){return Array.isArray(v)?v.map(sort):object(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,item])=>[k,sort(item)])):v;})(value));
    const galleryItemKey=item=>[item.provider,item.account_id,item.id].join(':');
    function galleryScope(meta) {
      const args={...meta.refresh?.arguments};delete args[meta.pagination?.cursorInput];
      return galleryStable({tool:meta.tool,provider:meta.provider,account:meta.accountId,project:meta.context?.project_id,filters:args});
    }
    function galleryMatches(meta,expected) {return meta.tool===expected.tool && meta.provider===expected.provider && meta.accountId===expected.accountId && meta.context?.project_id===expected.context?.project_id;}
    function galleryArgsMatchScope(args,meta) {return object(args) && args.account_id===meta.accountId && args.project_id===meta.context?.project_id && !Object.hasOwn(args,'pending_operation_id');}
    function galleryActions(creative,meta) {
      if(meta.capabilities?.can_write!==true || !meta.provider || !meta.accountId || creative.provider!==meta.provider || creative.account_id!==meta.accountId) return [];
      return arr(creative.actions).filter(action=>object(action) && typeof action.tool==='string' && action.tool.startsWith(meta.provider+'_') && object(action.arguments) && action.arguments.account_id===creative.account_id && !Object.hasOwn(action.arguments,'pending_operation_id') && (!action.arguments.project_id || action.arguments.project_id===meta.context?.project_id) && arr(action.fields).length>0 && arr(action.fields).every(field=>object(field) && typeof field.key==='string' && /^[a-z][a-z0-9_]*$/.test(field.key) && !['account_id','project_id','pending_operation_id','constructor','prototype','__proto__'].includes(field.key) && !Object.hasOwn(action.arguments,field.key) && ['text','text_list','url_list','select'].includes(field.type) && (typeof field.value==='string' || Array.isArray(field.value) && field.value.every(v=>typeof v==='string'))) && new Set(action.fields.map(field=>field.key)).size===action.fields.length).slice(0,8);
    }
    function galleryMenu(creative) {
      const actions=galleryActions(creative,providerGallery.meta);
      return actions.length?'<details class="creative-menu"><summary aria-label="Actions for '+esc(creative.name || 'creative')+'">⋯</summary><div class="creative-menu-items">'+actions.map((action,index)=>'<button type="button" data-creative-action="'+index+'">'+esc(action.label || 'Edit creative')+'</button>').join('')+'</div></details>':'';
    }
    function galleryNext(meta) {
      const args=meta.next?.arguments,key=meta.pagination?.cursorInput,base=meta.refresh?.arguments;
      if(typeof key!=='string' || !/^[a-z][a-z0-9_]*$/.test(key) || ['account_id','project_id','pending_operation_id','constructor','prototype'].includes(key) || !galleryArgsMatchScope(args,meta) || !object(base)) return null;
      const immutable=value=>Object.fromEntries(Object.entries(value).filter(([field])=>field!==key));
      if(galleryStable(immutable(args))!==galleryStable(immutable(base)) || galleryStable(args[key])===galleryStable(base[key]) || !(typeof args[key]==='string' && args[key] || typeof args[key]==='number' && Number.isSafeInteger(args[key]) && args[key]>=0)) return null;
      return {...args};
    }
    function galleryPageValue(response,gallery,args) {
      const value=resultData(response),meta=value?._adport;
      if(response?.isError || value?.error || !Array.isArray(value?.creatives) || !meta || !galleryMatches(meta,gallery.meta) || !galleryArgsMatchScope(args,meta) || !object(meta.refresh?.arguments) || galleryStable(meta.refresh.arguments)!==galleryStable(args) || value.creatives.some(item=>item.provider!==meta.provider || item.account_id!==meta.accountId)) throw new Error('The gallery response could not be confirmed.');
      return value;
    }
    function updateGalleryCard(card,old,item,gallery) {
      const template=document.createElement('template');template.innerHTML=creativeCards([item],galleryMenu);const fresh=template.content.firstElementChild;
      for(const selector of ['.creative-heading','.creative-copy','.creative-footer']) card.querySelector(selector)?.replaceChildren(...fresh.querySelector(selector).childNodes);
      const mediaKey=items=>galleryStable(arr(items).map(media=>{const path=value=>{try {const url=new URL(value);return url.origin+url.pathname;} catch {return value;}};return {type:media.type,url:path(media.url),poster:path(media.poster_url)};}));
      if(mediaKey(old.media)!==mediaKey(item.media)) {card.querySelector('.creative-media')?.remove();const media=fresh.querySelector('.creative-media');if(media) card.querySelector('.creative-copy').before(media);bindCreativeErrors(card);}
      else {
        const links=card.querySelectorAll('.creative-media a'),next=fresh.querySelectorAll('.creative-media a');links.forEach((link,index)=>{if(next[index]) link.href=next[index].href;});
        const labels=card.querySelectorAll('.creative-media [aria-label],.creative-media img'),freshLabels=fresh.querySelectorAll('.creative-media [aria-label],.creative-media img');labels.forEach((node,index)=>{const label=freshLabels[index];if(label) for(const key of ['aria-label','alt']) {if(label.hasAttribute(key)) node.setAttribute(key,label.getAttribute(key));else node.removeAttribute(key);}});
      }
      bindGalleryCard(card,gallery);
    }
    function renderProviderGallery(data,meta) {
      const previous=providerGallery,previousWrite=previous?.meta.capabilities?.can_write,retain=previous && previous.scope===galleryScope(meta) && app.querySelector('[data-provider-gallery]');
      if(!retain) providerGallery={scope:galleryScope(meta),data,meta,items:new Map(),sources:new Map(),seen:new Set(),busy:null,review:null};
      const gallery=providerGallery;gallery.data=data;gallery.meta=meta;
      if(!retain) app.innerHTML=chrome('<div data-provider-notes></div><div class="creative-grid" data-provider-gallery role="region" aria-label="Creative previews" tabindex="0"></div><div data-provider-pages></div>','');
      const root=app.querySelector('[data-provider-gallery]');
      for(const item of arr(data.creatives)) {
        const key=galleryItemKey(item);if(gallery.items.has(key)) {const old=gallery.items.get(key);if(galleryStable(old)!==galleryStable(item) || previousWrite!==meta.capabilities?.can_write) {const card=[...root.querySelectorAll('[data-creative-key]')].find(node=>node.dataset.creativeKey===key);gallery.items.set(key,item);if(card) {if(meta.capabilities?.can_write!==true) card.querySelector('[data-creative-editor]')?.remove();updateGalleryCard(card,old,item,gallery);}}continue;}
        gallery.items.set(key,item);gallery.sources.set(key,meta.refresh?.arguments);
        const template=document.createElement('template');template.innerHTML=creativeCards([item],galleryMenu);const card=template.content.firstElementChild;card.dataset.creativeKey=key;root.append(card);bindGalleryCard(card,gallery);bindCreativeErrors(card);
      }
      root.querySelector('.empty')?.remove();if(!gallery.items.size) root.innerHTML='<div class="empty">No creatives to preview.</div>';
      root.classList.toggle('creative-grid-single',gallery.items.size===1);
      app.querySelector('[data-provider-notes]').innerHTML=notices({...data,truncated:false});
      state.result={structuredContent:{...data,creatives:[...gallery.items.values()],_adport:meta}};renderProviderPages();
    }
    function renderProviderPages(message='') {
      const gallery=providerGallery,area=app.querySelector('[data-provider-pages]');if(!gallery || !area) return;
      const next=galleryNext(gallery.meta),focused=area.querySelector('button')===document.activeElement;
      area.innerHTML=(message?'<p class="provider-message" role="status">'+esc(message)+'</p>':'')+(next?'<div class="provider-pages"><button class="media-button" type="button" data-provider-more aria-disabled="'+!!gallery.busy+'">'+(gallery.busy?.kind==='page'?'Loading…':'Load more')+'</button></div>':gallery.data.truncated?'<p class="provider-message">More creatives may exist. Ask your assistant for the next page.</p>':'');
      area.querySelector('[data-provider-more]')?.addEventListener('click',loadProviderPage);
      if(focused) (area.querySelector('button') || app.querySelector('[data-provider-gallery]'))?.focus({preventScroll:true});
    }
    async function loadProviderPage() {
      const gallery=providerGallery,args=gallery && galleryNext(gallery.meta);if(!gallery || gallery.busy || !args) return;
      const fingerprint=galleryStable(args);if(gallery.seen.has(fingerprint)) {gallery.meta={...gallery.meta,next:undefined};renderProviderPages('No new page was returned.');return;}
      gallery.busy={kind:'page',tool:gallery.meta.tool,args};renderProviderPages();
      try {
        const response=await callTool(gallery.meta.tool,args,60000),value=galleryPageValue(response,gallery,args);if(providerGallery!==gallery) return;
        gallery.seen.add(fingerprint);state.hasLocalResult=true;hostResults.add(JSON.stringify(value));
        const next=galleryNext(value._adport),meta={...value._adport,...(next && !gallery.seen.has(galleryStable(next))?{}:{next:undefined})};
        gallery.busy=null;renderProviderGallery(value,meta);
      } catch(error) {if(providerGallery===gallery) renderProviderPages(error?.message || 'Could not load more creatives.');}
      finally {if(providerGallery===gallery) {gallery.busy=null;const button=app.querySelector('[data-provider-more]');if(button) {button.setAttribute('aria-disabled','false');button.textContent='Load more';}}}
    }
    function bindGalleryCard(card,gallery) {
      card.querySelectorAll('[data-creative-action]').forEach(button=>button.addEventListener('click',()=>{
        if(providerGallery!==gallery || gallery.busy) return;
        const item=gallery.items.get(card.dataset.creativeKey),action=galleryActions(item,gallery.meta)[Number(button.dataset.creativeAction)];if(!action) return;
        card.querySelectorAll('.creative-menu').forEach(menu=>{menu.open=false;});openGalleryEditor(card,item,action,gallery);
      }));
      card.querySelector('.creative-menu')?.addEventListener('keydown',event=>{if(event.key==='Escape') {event.currentTarget.open=false;event.currentTarget.querySelector('summary').focus();}});
      card.querySelector('.creative-menu')?.addEventListener('toggle',event=>{if(event.currentTarget.open) app.querySelectorAll('.creative-menu[open]').forEach(menu=>{if(menu!==event.currentTarget) menu.open=false;});});
    }
    function openGalleryEditor(card,item,action,gallery) {
      card.querySelector('[data-creative-editor]')?.remove();const form=document.createElement('form');form.className='creative-editor';form.dataset.creativeEditor='';form.setAttribute('aria-label',action.label || 'Edit creative');
      form.innerHTML=action.fields.map((field,index)=>{const value=Array.isArray(field.value)?field.value.join('\n'):field.value;
        const input=field.type==='select'?'<select data-field="'+index+'">'+arr(field.options).filter(option=>typeof option.value==='string').map(option=>'<option value="'+esc(option.value)+'" '+(option.value===value?'selected':'')+'>'+esc(option.label || option.value)+'</option>').join('')+'</select>':field.type!=='text' || value.includes('\n') || value.length>120?'<textarea data-field="'+index+'" rows="3">'+esc(value)+'</textarea>':'<input data-field="'+index+'" value="'+esc(value)+'">';
        return '<label>'+esc(field.label || field.key)+input+'</label>';}).join('')+'<p class="provider-message" role="alert" data-editor-error hidden></p><div class="creative-editor-actions"><button class="media-button" type="button" data-editor-cancel>Cancel</button><button class="media-button primary" type="submit">Preview changes</button></div>';
      card.append(form);form.querySelector('[data-field]')?.focus({preventScroll:true});form.scrollIntoView?.({block:'nearest'});
      form.querySelector('[data-editor-cancel]').addEventListener('click',()=>{if(!gallery.busy) {form.remove();card.querySelector('.creative-menu>summary')?.focus({preventScroll:true});}});
      form.addEventListener('submit',async event=>{
        event.preventDefault();if(providerGallery!==gallery || gallery.busy) return;
        const error=form.querySelector('[data-editor-error]'),args={...action.arguments,...(gallery.meta.context?.project_id?{project_id:gallery.meta.context.project_id}:{})};error.hidden=true;
        try {
          action.fields.forEach((field,index)=>{const raw=form.querySelector('[data-field="'+index+'"]').value,value=['text_list','url_list'].includes(field.type)?raw.split(/\r?\n/).map(v=>v.trim()).filter(Boolean):raw;
            if(field.max_length && (Array.isArray(value)?value:[value]).some(v=>v.length>field.max_length)) throw new Error((field.label || field.key)+' is too long.');
            if(field.type==='select' && !arr(field.options).some(option=>option.value===value)) throw new Error('Choose a listed option.');args[field.key]=value;});
          gallery.busy={kind:'preview',tool:action.tool,args};form.querySelectorAll('button,input,textarea,select').forEach(node=>{node.disabled=true;});form.querySelector('[type="submit"]').textContent='Preparing preview…';
          const response=await callTool(action.tool,args,180000),value=resultData(response);if(providerGallery!==gallery) return;
          if(response?.isError || value?.error || value.status!=='pending_validation' || value.applied!==false || typeof value.pending_operation_id!=='string' || value._adport?.tool!==action.tool || value._adport?.accountId!==item.account_id || value._adport?.context?.project_id!==gallery.meta.context?.project_id) throw new Error('The preview could not be confirmed. Check the tool result before trying again.');
          const fragment=document.createDocumentFragment(),root=app.querySelector('[data-provider-gallery]');gallery.review={fragment,key:galleryItemKey(item),tool:action.tool,pending:value.pending_operation_id,scroll:root.scrollTop};while(app.firstChild) fragment.append(app.firstChild);
          gallery.busy=null;acceptResult(response,true);
        } catch(problem) {if(providerGallery===gallery) {error.textContent=problem?.message || 'The preview could not be confirmed.';error.hidden=false;}}
        finally {if(providerGallery===gallery) {gallery.busy=null;form.querySelectorAll('button,input,textarea,select').forEach(node=>{node.disabled=false;});form.querySelector('[type="submit"]').textContent='Preview changes';}}
      });
    }
    function providerGalleryIgnoreEcho(data) {
      const busy=providerGallery?.busy,meta=data?._adport;
      return !!busy && meta?.tool===busy.tool && (!meta.accountId || meta.accountId===providerGallery.meta.accountId) && (!meta.context?.project_id || meta.context.project_id===providerGallery.meta.context?.project_id);
    }
    function providerGalleryReviewControls(data,meta) {
      const gallery=providerGallery,review=gallery?.review;if(!review) return;
      if(meta.tool!==review.tool || meta.accountId!==gallery.meta.accountId || meta.context?.project_id!==gallery.meta.context?.project_id) {providerGallery=null;return;}
      const footer=app.querySelector('.operation-footer');if(!footer) return;
      const back=document.createElement('button');back.type='button';back.className='media-button';back.textContent='Back';back.setAttribute('aria-label','Back to creatives');back.disabled=attempts.get(review.pending)?.phase==='applying';footer.prepend(back);
      back.addEventListener('click',async()=>{
        if(providerGallery!==gallery || attempts.get(review.pending)?.phase==='applying') return;
        cancelHold();clearTimeout(expiryTimer);const phase=attempts.get(review.pending)?.phase;app.replaceChildren(review.fragment);gallery.review=null;
        const root=app.querySelector('[data-provider-gallery]');root.scrollTop=review.scroll;state.result={structuredContent:{...gallery.data,creatives:[...gallery.items.values()],_adport:gallery.meta}};
        const card=[...root.querySelectorAll('[data-creative-key]')].find(node=>node.dataset.creativeKey===review.key);card?.querySelector('.creative-menu>summary')?.focus({preventScroll:true});
        if(!['applied','unconfirmed','partial'].includes(phase)) return;
        card?.querySelector('[data-creative-editor]')?.remove();const args=gallery.sources.get(review.key);
        if(!galleryArgsMatchScope(args,gallery.meta)) {renderProviderPages('Ask your assistant for a fresh view before editing again.');return;}
        gallery.busy={kind:'refresh',tool:gallery.meta.tool,args};renderProviderPages();
        try {
          const response=await callTool(gallery.meta.tool,args,60000),value=galleryPageValue(response,gallery,args);if(providerGallery!==gallery) return;
          const updated=value.creatives.find(item=>galleryItemKey(item)===review.key);if(!updated) throw new Error('The edited creative is outside this page. Ask your assistant for a fresh view.');
          const old=gallery.items.get(review.key);gallery.items.set(review.key,updated);if(card) updateGalleryCard(card,old,updated,gallery);
          state.result={structuredContent:{...gallery.data,creatives:[...gallery.items.values()],_adport:gallery.meta}};state.hasLocalResult=true;
        } catch(problem) {if(providerGallery===gallery) {card?.querySelector('.creative-menu')?.remove();renderProviderPages(problem?.message || 'The updated creative could not be read. Ask your assistant for a fresh view.');}}
        finally {if(providerGallery===gallery) {gallery.busy=null;const more=app.querySelector('[data-provider-more]');more?.setAttribute('aria-disabled','false');}}
      });
    }
`;
