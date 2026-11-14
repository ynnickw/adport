import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

const project='b310e750-d001-4427-8184-09bd05920e01';
const cursor='11111111-1111-4111-8111-111111111111';
const video=(id: string)=>({id,provider:'media',name:id,status:'READY',media:[{type:'video',url:`https://storage.example/${id}.mp4`}]});
function page(items: ReturnType<typeof video>[],next?: string, context=project) {
  return {structuredContent:structuredResult('media_list','creatives',{creatives:items,assets:[],truncated:!!next},undefined,{project_id:context},{can_write:false},{arguments:{limit:2,kind:'video',query:'test',project_id:context}},next?{arguments:{limit:2,kind:'video',query:'test',cursor:next,project_id:context}}:undefined)};
}
function fixture(next=cursor) {
  const callTool=vi.fn();
  const dom=new JSDOM(ADPORT_UI_HTML,{runScripts:'dangerously',url:'https://widget.example',beforeParse(window){Object.defineProperty(window,'openai',{value:{callTool}});}});
  const notify=(value: unknown)=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:dom.window.parent,data:{jsonrpc:'2.0',method:'ui/notifications/tool-result',params:value}}));
  notify(page([video('first'),video('second')],next));
  return {dom,callTool,notify,document:dom.window.document,more:()=>dom.window.document.querySelector<HTMLButtonElement>('[data-library-more]')!};
}

describe('compact central media library',()=>{
  it('appends pages with unchanged scope and filters while retaining players, focus and scroll',async()=>{
    const f=fixture();
    try {
      const gallery=f.document.querySelector<HTMLElement>('[data-media-gallery]')!,player=f.document.querySelector('video')!;
      gallery.scrollTop=80;player.currentTime=9;f.more().focus();
      let resolve!: (value: unknown)=>void;f.callTool.mockImplementation(()=>new Promise(done=>{resolve=done;}));
      f.more().click();f.more().click();
      await vi.waitFor(()=>expect(f.callTool).toHaveBeenCalledTimes(1));
      expect(f.callTool).toHaveBeenCalledWith('media_list',{limit:2,kind:'video',query:'test',cursor,project_id:project});
      // Hosts can echo the nested read before resolving its bridge request.
      f.notify(page([video('second'),video('third')]));
      expect(f.document.querySelectorAll('article')).toHaveLength(2);
      resolve(page([video('second'),video('third')]));
      await vi.waitFor(()=>expect(f.document.querySelectorAll('article')).toHaveLength(3));
      expect(f.document.querySelector('video')).toBe(player);expect(player.currentTime).toBe(9);
      expect(f.document.querySelector('[data-media-gallery]')).toBe(gallery);expect(gallery.scrollTop).toBe(80);expect(f.document.activeElement).toBe(gallery);
      expect(f.document.querySelector('[data-library-more]')).toBeNull();
      expect(f.document.querySelector('main')!.textContent).not.toMatch(/Organize|Distribute|Channel labels|Select files/);
    } finally {f.dom.window.close();}
  });

  it('rejects a foreign-project page and allows a failed read to be retried without losing loaded cards',async()=>{
    const f=fixture();
    try {
      f.callTool.mockResolvedValueOnce(page([video('foreign')],undefined,'22222222-2222-4222-8222-222222222222'));
      f.more().click();await vi.waitFor(()=>expect(f.document.querySelector('main')!.textContent).toContain('could not be confirmed'));
      expect(f.document.querySelectorAll('article')).toHaveLength(2);expect(f.more().disabled).toBe(false);
      f.callTool.mockResolvedValueOnce(page([video('third')]));f.more().click();
      await vi.waitFor(()=>expect(f.document.querySelectorAll('article')).toHaveLength(3));
      expect(f.document.querySelector('main')!.textContent).not.toContain('foreign');
    } finally {f.dom.window.close();}
  });

  it('removes cyclic continuation and ignores a late page after a project change',async()=>{
    const f=fixture();
    try {
      f.callTool.mockResolvedValueOnce(page([video('third')],cursor));f.more().click();
      await vi.waitFor(()=>expect(f.document.querySelectorAll('article')).toHaveLength(3));
      expect(f.document.querySelector('[data-library-more]')).toBeNull();
      f.notify(page([video('original')],cursor));
      let resolve!: (value: unknown)=>void;f.callTool.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
      // A different initial filter resets its own pagination range.
      const different=page([video('original')],cursor);different.structuredContent._adport={...(different.structuredContent._adport as object),tool:'media_list',view:'creatives',context:{project_id:project},refresh:{arguments:{limit:2}}};
      f.notify(different);f.more().click();await vi.waitFor(()=>expect(f.callTool).toHaveBeenCalledTimes(2));
      f.notify(page([video('new-project')],undefined,'22222222-2222-4222-8222-222222222222'));
      resolve(page([video('stale')]));
      await new Promise(done=>setTimeout(done,0));
      expect(f.document.querySelectorAll('article')).toHaveLength(1);expect(f.document.querySelector('.creative-name')?.textContent).toBe('new-project');
    } finally {f.dom.window.close();}
  });
});

const previewId='33333333-3333-4333-8333-333333333333';
const previewAsset={id:previewId,name:'QA video',sha256:'a'.repeat(64),byte_length:1234,content_type:'video/mp4',status:'READY',preview_url:'https://storage.example/expired.mp4'};
function previewPage(context=project) {
  const result=page([video(previewId),video('healthy')],cursor,context);
  Object.assign(result.structuredContent,{assets:[previewAsset]});
  return result;
}
const renewed=(overrides: Record<string,unknown>={},context=project)=>({structuredContent:structuredResult('media_get','data',{asset:{...previewAsset,preview_url:'https://storage.example/renewed.mp4',...overrides}},undefined,{project_id:context})});

describe('central widget preview renewal',()=>{
  it('renews just the failed source through a scoped read and ignores host echoes',async()=>{
    const f=fixture();
    try {
      f.notify(previewPage());
      const gallery=f.document.querySelector<HTMLElement>('[data-media-gallery]')!,healthy=f.document.querySelectorAll('video')[1]!;
      gallery.scrollTop=70;healthy.currentTime=8;
      let resolve!: (value: unknown)=>void;f.callTool.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
      f.document.querySelector('video')!.dispatchEvent(new f.dom.window.Event('error'));
      await vi.waitFor(()=>expect(f.callTool).toHaveBeenCalledTimes(1));
      expect(f.callTool).toHaveBeenCalledWith('media_get',{media_id:previewId,project_id:project});
      f.notify(renewed());
      expect(f.document.querySelector('[data-media-gallery]')).toBe(gallery);
      resolve(renewed());
      await vi.waitFor(()=>expect(f.document.querySelector('video')?.getAttribute('src')).toBe('https://storage.example/renewed.mp4'));
      expect(f.document.querySelectorAll('video')[1]).toBe(healthy);expect(healthy.currentTime).toBe(8);expect(gallery.scrollTop).toBe(70);
      expect(f.document.querySelector('[data-library-more]')).not.toBeNull();
      f.notify(renewed());expect(f.document.querySelector('[data-media-gallery]')).toBe(gallery);
    } finally {f.dom.window.close();}
  });

  it('bounds automatic renewal and permits a deliberate single-flight retry',async()=>{
    const f=fixture();
    try {
      f.notify(previewPage());f.callTool.mockResolvedValueOnce(renewed());
      f.document.querySelector('video')!.dispatchEvent(new f.dom.window.Event('error'));
      await vi.waitFor(()=>expect(f.document.querySelector('video')?.getAttribute('src')).toContain('renewed'));
      f.document.querySelector('video')!.dispatchEvent(new f.dom.window.Event('error'));
      expect(f.callTool).toHaveBeenCalledTimes(1);
      const retry=f.document.querySelector<HTMLButtonElement>('[data-preview-retry]')!;
      expect(retry.getAttribute('aria-label')).toBe('Retry preview: QA video');
      let resolve!: (value: unknown)=>void;f.callTool.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
      retry.click();retry.click();await vi.waitFor(()=>expect(f.callTool).toHaveBeenCalledTimes(2));
      resolve(renewed({preview_url:'https://storage.example/manual.mp4'}));
      await vi.waitFor(()=>expect(f.document.querySelector('video')?.getAttribute('src')).toContain('manual'));
    } finally {f.dom.window.close();}
  });

  it.each([
    [{sha256:'b'.repeat(64)},project],
    [{status:'DELETED'},project],
    [{content_type:'image/png'},project],
    [{byte_length:1},project],
    [{},'22222222-2222-4222-8222-222222222222'],
    [{preview_url:'javascript:alert(1)'},project],
  ])('rejects mismatched or unsafe renewal %j',async(overrides,context)=>{
    const f=fixture();
    try {
      f.notify(previewPage());f.callTool.mockResolvedValueOnce(renewed(overrides,context));
      f.document.querySelector('video')!.dispatchEvent(new f.dom.window.Event('error'));
      await vi.waitFor(()=>expect(f.document.querySelector('[data-preview-retry]')).not.toBeNull());
      expect(f.document.querySelectorAll('video')).toHaveLength(1);expect(f.callTool).toHaveBeenCalledTimes(1);
    } finally {f.dom.window.close();}
  });

  it('discards a late renewal after a filter or project change',async()=>{
    const f=fixture();
    try {
      f.notify(previewPage());let resolve!: (value: unknown)=>void;
      f.callTool.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
      f.document.querySelector('video')!.dispatchEvent(new f.dom.window.Event('error'));
      await vi.waitFor(()=>expect(f.callTool).toHaveBeenCalledTimes(1));
      f.notify(previewPage('22222222-2222-4222-8222-222222222222'));const current=f.document.querySelector('video');
      f.notify(renewed());expect(f.document.querySelector('video')).toBe(current);
      resolve(renewed());await new Promise(done=>setTimeout(done,0));
      expect(f.document.querySelector('video')).toBe(current);expect(current?.getAttribute('src')).not.toContain('renewed');
    } finally {f.dom.window.close();}
  });

  it('does not use central media reads for native provider IDs or assets without a checksum',()=>{
    const f=fixture();
    try {f.document.querySelector('video')!.dispatchEvent(new f.dom.window.Event('error'));expect(f.callTool).not.toHaveBeenCalled();expect(f.document.querySelector('[data-preview-retry]')).toBeNull();}
    finally {f.dom.window.close();}
  });

  it('retains in-flight echo guards when more than 32 previews expire together',async()=>{
    const f=fixture();
    try {
      const assets=Array.from({length:40},(_,i)=>({...previewAsset,id:`33333333-3333-4333-8333-${String(i).padStart(12,'0')}`}));
      const many=page(assets.map(asset=>video(asset.id)));Object.assign(many.structuredContent,{assets});f.notify(many);
      f.callTool.mockImplementation(()=>new Promise(()=>{}));
      f.document.querySelectorAll('video').forEach(player=>player.dispatchEvent(new f.dom.window.Event('error')));
      await vi.waitFor(()=>expect(f.callTool).toHaveBeenCalledTimes(40));
      const next=page([video('different-project')],undefined,'22222222-2222-4222-8222-222222222222');f.notify(next);
      const gallery=f.document.querySelector('[data-media-gallery]');
      f.notify(renewed({id:assets[0]!.id}));
      expect(f.document.querySelector('[data-media-gallery]')).toBe(gallery);
      expect(f.document.querySelector('.creative-name')?.textContent).toBe('different-project');
    } finally {f.dom.window.close();}
  });
});
