/** Embedded in the MCP App; all library mutations use the existing host tool bridge. */
export const MEDIA_UPLOAD_UI = String.raw`
    const uploads={project:null,items:[],running:false,sequence:0,error:''};
    const uploadUuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
    const uploadBytes=value=>value>=1048576?(value/1048576).toFixed(1)+' MB':Math.max(1,Math.ceil(value/1024))+' KB';
    function uploadContext(data,meta) {
      const config=data.upload_config,project=config?.project_id;
      if (meta.tool!=='media_list'||meta.capabilities?.can_write!==true||!uploadUuid(project)||meta.context?.project_id&&meta.context.project_id!==project) return null;
      try {
        const origin=new URL(config.storage_origin);
        if (origin.protocol!=='https:'||origin.origin!==config.storage_origin||!Number.isInteger(config.max_bytes)||config.max_bytes<1||config.max_bytes>52428800||!Array.isArray(config.content_types)) return null;
        return {project,config};
      } catch {return null;}
    }
    function uploadDraw() {
      const panel=app.querySelector('[data-upload-panel]');if(!panel || !mediaLibrary) return;
      const context=uploadContext(mediaLibrary.data,mediaLibrary.meta),items=uploads.project===mediaLibrary.project?uploads.items:[];
      if(!context) {panel.replaceChildren();return;}
      const queued=items.filter(item=>item.status==='Queued').length,ready=items.filter(item=>item.status==='Ready').length;
      panel.innerHTML=(items.length?'<div class="widget-upload-queue" data-upload-queue>'+items.map(item=>'<div class="widget-upload-row" data-upload-key="'+item.key+'"><div><strong title="'+esc(item.file.name)+'">'+esc(item.file.name)+'</strong><small>'+uploadBytes(item.file.size)+'</small></div><span class="widget-upload-status" role="status">'+esc(item.status)+(item.status==='Uploading'?' '+item.percent+'%':'')+'</span>'+(['Queued','Needs review'].includes(item.status)&&!item.mediaId?'<button class="media-button" type="button" data-upload-remove="'+item.key+'" aria-label="Remove '+esc(item.file.name)+' from queue" '+(uploads.running?'disabled':'')+'>×</button>':'')+(item.status==='Needs review'&&item.mediaId?'<button class="media-button" type="button" data-upload-verify="'+item.key+'" '+(uploads.running?'disabled':'')+'>Verify upload</button>':'')+(item.status==='Uploading'?'<progress max="100" value="'+item.percent+'" aria-label="Upload progress for '+esc(item.file.name)+'"></progress>':'')+(item.message?'<p role="alert">'+esc(item.message)+'</p>':'')+'</div>').join('')+'</div>':'')+(uploads.error?'<p class="media-message" role="alert">'+esc(uploads.error)+'</p>':'')+(items.length?'<div class="widget-upload-actions">'+(ready?'<span class="widget-upload-summary" role="status">'+ready+' saved to your library</span><button class="media-button" data-upload-clear '+(uploads.running?'disabled':'')+'>Clear completed</button>':'')+(queued?'<button class="media-button primary" data-upload-start '+(uploads.running?'disabled':'')+'>Upload '+queued+' file'+(queued===1?'':'s')+'</button>':'')+'</div>':'');
      const input=app.querySelector('[data-upload-files]');if(input) input.disabled=uploads.running;
      panel.querySelectorAll('[data-upload-remove]').forEach(button=>button.addEventListener('click',()=>{if(uploads.running)return;uploads.items=uploads.items.filter(item=>item.key!==Number(button.dataset.uploadRemove));uploadDraw();}));
      panel.querySelector('[data-upload-clear]')?.addEventListener('click',()=>{if(uploads.running)return;uploads.items=uploads.items.filter(item=>item.status!=='Ready');uploadDraw();});
      panel.querySelector('[data-upload-start]')?.addEventListener('click',()=>startWidgetUploads(context));
      panel.querySelectorAll('[data-upload-verify]').forEach(button=>button.addEventListener('click',()=>verifyWidgetUpload(Number(button.dataset.uploadVerify))));
    }
    function uploadType(file) {
      const ext={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',heic:'image/heic',gif:'image/gif',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',pdf:'application/pdf'};
      return ['audio/x-wav','audio/vnd.wave','audio/wave'].includes(file.type)?'audio/wav':file.type&&file.type!=='application/octet-stream'?file.type:ext[file.name.split('.').pop().toLowerCase()]||'';
    }
    function queueWidgetFiles(files,context) {
      if (uploads.running) return;
      if (uploads.project!==context.project) {uploads.project=context.project;uploads.items=[];}
      uploads.error='';
      for (const file of Array.from(files||[])) {
        if (uploads.items.length>=50) {uploads.error='Choose up to 50 files in one batch.';break;}
        const contentType=uploadType(file),valid=file.size>0&&file.size<=context.config.max_bytes&&context.config.content_types.includes(contentType)&&file.name.trim().length>0&&file.name.trim().length<=240;
        uploads.items.push({key:++uploads.sequence,file,contentType,context,status:valid?'Queued':'Needs review',percent:0,message:valid?'':'Choose a supported, non-empty file with a name up to 240 characters and within the size limit.'});
      }
      uploadDraw();
    }
    async function uploadCall(tool,args) {
      const response=await callTool(tool,args,180000),value=resultData(response);
      if (response?.isError||value?.error) throw new Error('The library request was not confirmed. Check the result in chat before trying again.');
      return value;
    }
    async function uploadChange(tool,args) {
      const preview=await uploadCall(tool,args);
      if (preview?.status!=='pending_validation'||preview.applied!==false||typeof preview.pending_operation_id!=='string') throw new Error('The library did not return an upload preview.');
      // No apply retry: each approval is consumed by one call, including unknown outcomes.
      const applied=await uploadCall(tool,{...args,pending_operation_id:preview.pending_operation_id});
      if (applied?.status!=='applied'||applied.applied!==true) throw new Error('The library did not confirm this upload operation.');
      return applied.result;
    }
    async function widgetHash(bytes) {
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    }
    async function finalizeWidgetFile(item) {
      item.status='Verifying';item.message='';item.finalizeAttempted=true;uploadDraw();
      const result=await uploadChange('media_finalize_upload',{media_id:item.mediaId,expected_sha256:item.sha256,project_id:item.context.project});
      const asset=result?.details?.asset;
      if (!exactWidgetAsset(item,asset)||asset.status!=='READY') throw new Error('The library has not confirmed the exact file is ready. Verify this upload.');
      markWidgetFileReady(item,asset);
      // The apply receipt intentionally omits signed previews; the read can hydrate this one card.
      try {const value=await uploadCall('media_get',{media_id:item.mediaId,project_id:item.context.project});if(exactWidgetAsset(item,value?.asset)&&value.asset.status==='READY') showUploadedAsset(item,value.asset);} catch {}
    }
    const exactWidgetAsset=(item,asset)=>asset?.id===item.mediaId&&asset.sha256===item.sha256&&asset.byte_length===item.file.size&&asset.content_type===item.contentType;
    function markWidgetFileReady(item,asset) {
      item.status='Ready';item.assetName=asset.name;item.percent=100;item.message='';showUploadedAsset(item,asset);uploadDraw();
    }
    function shareWidgetUploads() {
      const facts={project_id:uploads.project,files:uploads.items.filter(item=>item.mediaId).map(item=>({media_id:item.mediaId,name:item.assetName||item.file.name,byte_length:item.file.size,sha256:item.sha256,status:item.status==='Ready'?'READY':'UNCONFIRMED'}))};
      if(typeof window.openai?.setWidgetState==='function') Promise.resolve().then(()=>window.openai.setWidgetState({adport_uploads:facts})).catch(()=>{});
      else send({jsonrpc:'2.0',id:id++,method:'ui/update-model-context',params:{structuredContent:{adport_uploads:facts}}});
    }
    async function transferWidgetFile(item) {
      try {
        item.status='Checking';uploadDraw();
        const bytes=await item.file.arrayBuffer();item.sha256=await widgetHash(bytes);
        const result=await uploadChange('media_prepare_upload',{name:item.file.name.trim(),content_type:item.contentType,byte_length:item.file.size,sha256:item.sha256,project_id:item.context.project});
        const grant=result?.details;
        if (uploadUuid(grant?.media_id)) item.mediaId=grant.media_id;
        const destination=new URL(grant?.upload_url);
        if (!item.mediaId||grant.method!=='PUT'||destination.origin!==item.context.config.storage_origin||destination.username||destination.password||destination.hash||destination.pathname!=='/storage/v1/object/upload/sign/creative-media/'+item.context.project+'/'+item.mediaId||!destination.searchParams.get('token')) throw new Error('The private upload destination could not be verified. No bytes were sent.');
        item.status='Uploading';uploadDraw();
        await new Promise((resolve,reject)=>{
          const xhr=new XMLHttpRequest();xhr.open('PUT',destination.href);xhr.timeout=300000;xhr.withCredentials=false;
          xhr.setRequestHeader('content-type',item.contentType);xhr.setRequestHeader('x-upsert','false');xhr.setRequestHeader('cache-control','max-age=0');
          xhr.upload.onprogress=event=>{if (event.lengthComputable) {item.percent=Math.round(event.loaded/event.total*100);const row=app.querySelector('[data-upload-queue]');if(row) {const element=row.querySelector('[data-upload-key="'+item.key+'"]');if(element) {element.querySelector('progress')?.setAttribute('value',String(item.percent));element.querySelector('.widget-upload-status').textContent='Uploading '+item.percent+'%';}}}};
          xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error('Transfer was not confirmed. Use Verify upload before sending the file again.'));
          xhr.onerror=xhr.ontimeout=xhr.onabort=()=>reject(new Error('Transfer was interrupted. Use Verify upload before sending the file again.'));
          xhr.send(bytes);
        });
        await finalizeWidgetFile(item);
      } catch(error) {item.status='Needs review';item.message=error?.message||'Upload was not confirmed. Check the result in chat.';uploadDraw();}
    }
    async function startWidgetUploads(context) {
      if(uploads.running || uploads.project!==context.project || !uploads.items.some(item=>item.status==='Queued')) return;
      uploads.running=true;uploads.error='';const waiting=uploads.items.filter(item=>item.status==='Queued');uploadDraw();
      const worker=async()=>{let item;while((item=waiting.shift())) await transferWidgetFile(item);};
      try {await Promise.all([worker(),worker()]);} finally {uploads.running=false;shareWidgetUploads();uploadDraw();}
    }
    async function verifyWidgetUpload(key) {
      if(uploads.running) return;const item=uploads.items.find(value=>value.key===key);if(!item?.mediaId) return;
      uploads.running=true;item.status='Verifying';item.message='';uploadDraw();
      try {
        const value=await uploadCall('media_get',{media_id:item.mediaId,project_id:item.context.project}),asset=value?.asset;
        if(!exactWidgetAsset(item,asset)) throw new Error('The file reference could not be verified. Check the result in chat.');
        if(asset.status==='READY') markWidgetFileReady(item,asset);
        else if(asset.status==='PROCESSING' && !item.finalizeAttempted) await finalizeWidgetFile(item);
        else throw new Error('The file is not ready yet. No bytes were resent. Check again later.');
      } catch(error) {item.status='Needs review';item.message=error?.message||'The upload could not be verified. No bytes were resent.';}
      finally {uploads.running=false;shareWidgetUploads();uploadDraw();}
    }
    function bindWidgetUpload(context) {
      const input=app.querySelector('[data-upload-files]');
      if(input) input.onchange=event=>{queueWidgetFiles(event.target.files,context);input.value='';};
      const drop=app.querySelector('[data-upload-drop]');if(!drop) return;
      let depth=0;
      const hasFiles=event=>Array.from(event.dataTransfer?.types || []).includes('Files');
      drop.ondragenter=event=>{if(!context||!hasFiles(event))return;event.preventDefault();depth++;if(!uploads.running)drop.classList.add('dragging');};
      drop.ondragover=event=>{if(!context||!hasFiles(event))return;event.preventDefault();event.dataTransfer.dropEffect=uploads.running?'none':'copy';};
      drop.ondragleave=()=>{if(--depth<=0){depth=0;drop.classList.remove('dragging');}};
      drop.ondrop=event=>{if(!context)return;event.preventDefault();depth=0;drop.classList.remove('dragging');queueWidgetFiles(event.dataTransfer?.files,context);};
    }
`;
