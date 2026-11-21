/** Read-only continuations keep the same scope and ignore host echoes until the bound reply arrives. */
export const READ_PAGE_UI = String.raw`
    let pendingReadPage=null;
    let readPageHistory=null;

    function readPageArgs(meta,selector) {
      const args=galleryNext(meta);
      const scope=galleryScope(meta);
      if(readPageHistory?.scope!==scope || readPageHistory.selector!==selector) {
        readPageHistory={scope,selector,seen:new Set()};
      }
      readPageHistory.seen.add(galleryStable(meta.refresh?.arguments));
      return args&&!readPageHistory.seen.has(galleryStable(args))?args:null;
    }

    function readPageMarkup(args,selector,statusSelector) {
      return args?'<div class="provider-pages"><button type="button" class="media-button" '+selector+'>Next page</button></div><p class="provider-message" '+statusSelector+' role="status"></p>':'';
    }

    function readPageIgnoreEcho(data) {
      const pending=pendingReadPage,meta=data?._adport;
      return !!pending&&!!meta&&galleryMatches(meta,pending.meta)&&galleryStable(meta.refresh?.arguments)===pending.key;
    }

    function bindReadPage(meta,args,selector,statusSelector,valid) {
      const button=app.querySelector('['+selector+']'),snapshot=state.result;
      button?.addEventListener('click',async()=>{
        if(button.disabled||state.result!==snapshot)return;
        const pending={meta,key:galleryStable(args)};
        pendingReadPage=pending;
        button.disabled=true;
        button.textContent='Loading…';
        try {
          const response=await callTool(meta.tool,args,60000),value=resultData(response),next=value?._adport;
          if(state.result!==snapshot) {rememberHostResult(JSON.stringify(value));return;}
          if(response?.isError||value?.error||!next||next.view!==meta.view||!galleryMatches(next,meta)||
            galleryScope(next)!==galleryScope(meta)||galleryStable(next.refresh?.arguments)!==pending.key||!valid(value)) {
            throw new Error('The next page could not be confirmed.');
          }
          rememberHostResult(JSON.stringify(value));
          acceptResult(response,true);
          (app.querySelector('['+selector+']')||app.querySelector('[data-read-page-focus]'))?.focus({preventScroll:true});
        } catch(error) {
          if(state.result===snapshot) {
            app.querySelector('['+statusSelector+']').textContent=error?.message||'Could not load the next page.';
            button.disabled=false;
            button.textContent='Next page';
          }
        } finally {if(pendingReadPage===pending)pendingReadPage=null;}
      });
    }
`;
