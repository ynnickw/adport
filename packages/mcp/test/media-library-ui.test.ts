import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

const project='203c14b1-c908-4632-9aa7-1be5de4ae9b0';
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
