import { createHash, webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

const project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0';
const otherProject = '11111111-1111-4111-8111-111111111111';
const storage = 'https://private-storage.example';
const config = { project_id: project, storage_origin: storage, max_bytes: 50 * 1024 * 1024, content_types: ['image/png', 'video/mp4', 'text/csv'] };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Args = Record<string, any>;

function fixture(options: { bridge?: 'mcp'; readOnly?: boolean; context?: string | null; destination?: (id: string) => string; transferError?: boolean; finalError?: boolean; maxBytes?: number; existing?: boolean; reconcileProcessing?: boolean; prepareError?: boolean } = {}) {
  const calls: Array<{ tool: string; args: Args }> = [], transfers: Array<{ method: string; url: string; headers: Record<string, string>; bytes: unknown; credentials: boolean }> = [];
  const reserved = new Map<string, Args>(); let count = 0, active = 0, maxActive = 0, token = 0;
  const gallery = () => ({ structuredContent: structuredResult('media_list', 'creatives', { creatives: [...(options.existing?[{id:'33333333-3333-4333-8333-333333333333',provider:'media',name:'Existing video',status:'READY',media:[{type:'video',url:storage+'/existing.mp4'}]}]:[]),...[...reserved].map(([id, source]) => ({ id, name: 'Uploaded ' + source.name, provider: 'media', type: source.content_type, status: 'READY' }))], assets: [], truncated: false, upload_config: { ...config, max_bytes: options.maxBytes ?? config.max_bytes } }, undefined, options.context === null ? undefined : { project_id: options.context ?? project }, { can_write: !options.readOnly }, { arguments: { limit: 24 } }) });
  const result = async (tool: string, args: Args) => {
    calls.push({ tool, args });
    if (tool === 'media_list') return gallery();
    const asset = () => ({ id: args.media_id, name: reserved.get(args.media_id)?.name, content_type: reserved.get(args.media_id)?.content_type, preview_url: storage+'/preview/'+args.media_id, byte_length: reserved.get(args.media_id)?.byte_length, sha256: reserved.get(args.media_id)?.sha256, status: 'READY' });
    if (tool === 'media_get') return { structuredContent: { asset: { ...asset(), ...(options.reconcileProcessing?{status:'PROCESSING'}:{}) } } };
    if (tool === 'media_prepare_upload' && args.pending_operation_id && options.prepareError) throw new Error('Unknown reservation outcome');
    if (!args.pending_operation_id) return { structuredContent: { status: 'pending_validation', applied: false, pending_operation_id: 'pending-' + ++token } };
    if (tool === 'media_prepare_upload') {
      const id = `22222222-2222-4222-8222-${String(++count).padStart(12, '0')}`; reserved.set(id, args);
      return { structuredContent: { status: 'applied', applied: true, result: { applied: true, resourceIds: [id], details: { media_id: id, upload_url: options.destination?.(id) ?? `${storage}/storage/v1/object/upload/sign/creative-media/${project}/${id}?token=temporary`, method: 'PUT' } } } };
    }
    if (options.finalError) throw new Error('Unknown finalize outcome');
    return { structuredContent: { status: 'applied', applied: true, result: { applied: true, details: { asset: asset() } } } };
  };
  const dom = new JSDOM(ADPORT_UI_HTML, { url: 'https://widget.example', runScripts: 'dangerously', beforeParse(window) {
    Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle });
    if (!options.bridge) Object.defineProperty(window, 'openai', { value: { callTool: result } });
    class Xhr {
      upload: { onprogress?: (event: unknown) => void } = {}; headers: Record<string, string> = {}; method = ''; url = ''; withCredentials = false; status = 200;
      onload?: () => void; onerror?: () => void;
      open(method: string, url: string) { this.method = method; this.url = url; }
      setRequestHeader(name: string, value: string) { this.headers[name] = value; }
      send(bytes: unknown) {
        transfers.push({ method: this.method, url: this.url, headers: this.headers, bytes, credentials: this.withCredentials }); maxActive = Math.max(maxActive, ++active);
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
        setTimeout(() => { active--; if (options.transferError) this.onerror?.(); else this.onload?.(); }, 10);
      }
    }
    Object.defineProperty(window, 'XMLHttpRequest', { value: Xhr });
  } });
  const messages: any[] = [];
  vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => {
    messages.push(message);
    if (options.bridge && message.method === 'tools/call') void result(message.params.name, message.params.arguments).then(value => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result: value } })));
  });
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: gallery() } }));
  const filesFor = (names: string[], bytes = Buffer.from('exact private bytes'), type = 'image/png') => names.map(name => { const file = new dom.window.File([bytes], name, { type }); Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); return file; });
  const choose = (names: string[], bytes = Buffer.from('exact private bytes'), type = 'image/png', drop = false) => {
    const files = filesFor(names, bytes, type);
    const target = dom.window.document.querySelector(drop ? '[data-upload-drop]' : '[data-upload-files]')!;
    const event = new dom.window.Event(drop ? 'drop' : 'change', { bubbles: true, cancelable: true });
    if (drop) Object.defineProperty(event, 'dataTransfer', { value: { files } }); else Object.defineProperty(target, 'files', { value: files, configurable: true });
    target.dispatchEvent(event);
  };
  const paste = (names: string[], options: { target?: Element; prevented?: boolean; bytes?: Buffer<ArrayBuffer>; type?: string } = {}) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: filesFor(names, options.bytes, options.type) } });
    if (options.prevented) event.preventDefault();
    (options.target ?? dom.window.document.querySelector('[data-upload-drop]')!).dispatchEvent(event);
    return event;
  };
  const click = (selector: string) => (dom.window.document.querySelector(selector) as HTMLButtonElement).click();
  return { dom, calls, transfers, messages, choose, paste, click, maxActive: () => maxActive, gallery };
}

describe('direct widget media upload', () => {
  it.each([undefined, 'mcp'] as const)('uploads dropped CSV through the %s bridge without navigation or replacing an existing player', async bridge => {
    const f = fixture({ bridge, existing: true }), bytes = Buffer.from('sku_id\r\n00012\r\n');
    try {
      const player = f.dom.window.document.querySelector('video')!;player.currentTime = 7;
      f.choose(['products.CSV'], bytes, 'text/plain', true);f.click('[data-upload-start]');
      await vi.waitFor(() => expect(f.dom.window.document.querySelector('main')!.textContent).toContain('1 saved to your library'));
      expect(f.calls.find(call => call.tool === 'media_prepare_upload')?.args).toEqual({ name: 'products.CSV', content_type: 'text/csv', byte_length: bytes.length, sha256: sha(bytes), project_id: project });
      expect(f.transfers).toHaveLength(1);expect(Buffer.from(f.transfers[0]!.bytes as ArrayBuffer)).toEqual(bytes);
      expect(f.transfers[0]!.headers['content-type']).toBe('text/csv');
      expect(f.dom.window.document.querySelector('video')).toBe(player);expect(player.currentTime).toBe(7);
      expect(f.dom.window.location.href).toBe('https://widget.example/');
    } finally { f.dom.window.close(); }
  });
  it.each([undefined, 'mcp'] as const)('queues pasted files through the %s bridge and uploads only after the upload button', async bridge => {
    const f=fixture({bridge,existing:true}), bytes=Buffer.from('exact clipboard file bytes');
    try {
      const player=f.dom.window.document.querySelector('video')!;player.currentTime=8;
      const event=f.paste(['pasted-one.png','pasted-two.png'],{bytes});
      expect(event.defaultPrevented).toBe(true);expect(f.calls).toHaveLength(0);expect(f.transfers).toHaveLength(0);
      expect(f.dom.window.document.querySelectorAll('[data-upload-key]')).toHaveLength(2);
      f.click('[data-upload-start]');
      await vi.waitFor(()=>expect(f.dom.window.document.querySelector('main')!.textContent).toContain('2 saved to your library'));
      expect(f.transfers).toHaveLength(2);expect(f.transfers.every(transfer=>Buffer.from(transfer.bytes as ArrayBuffer).equals(bytes))).toBe(true);
      for(const name of ['pasted-one.png','pasted-two.png'])expect(f.calls.find(call=>call.tool==='media_prepare_upload'&&!call.args.pending_operation_id&&call.args.name===name)?.args).toEqual({name,content_type:'image/png',byte_length:bytes.length,sha256:sha(bytes),project_id:project});
      expect(f.calls.filter(call=>call.args.pending_operation_id)).toHaveLength(4);
      expect(f.dom.window.document.querySelector('video')).toBe(player);expect(player.currentTime).toBe(8);
      expect(f.dom.window.location.href).toBe('https://widget.example/');
    }finally{f.dom.window.close();}
  });
  it('leaves text, editable content and previously handled paste events alone',()=>{
    const f=fixture();
    try {
      expect(f.paste([]).defaultPrevented).toBe(false);
      const root=f.dom.window.document.querySelector('[data-upload-drop]')!;
      for(const tag of ['textarea','input','div']){
        const target=f.dom.window.document.createElement(tag);if(tag==='div')target.setAttribute('contenteditable','true');root.append(target);
        expect(f.paste(['ignored.png'],{target}).defaultPrevented).toBe(false);target.remove();
      }
      f.paste(['already-handled.png'],{prevented:true});
      expect(f.dom.window.document.querySelector('[data-upload-queue]')).toBeNull();expect(f.calls).toHaveLength(0);
    }finally{f.dom.window.close();}
  });
  it('does not consume read-only file pastes or add files during an active upload',async()=>{
    const readOnly=fixture({readOnly:true});
    try{expect(readOnly.paste(['private.png']).defaultPrevented).toBe(false);expect(readOnly.calls).toHaveLength(0);}finally{readOnly.dom.window.close();}
    const f=fixture();
    try{
      f.choose(['first.png']);f.click('[data-upload-start]');expect(f.paste(['second.png']).defaultPrevented).toBe(false);
      await vi.waitFor(()=>expect(f.dom.window.document.querySelector('main')!.textContent).toContain('1 saved to your library'));
      expect(f.transfers).toHaveLength(1);expect(f.dom.window.document.querySelector('main')!.textContent).not.toContain('second.png');
    }finally{f.dom.window.close();}
  });
  it.each([undefined, 'mcp'] as const)('uploads through the %s bridge with exact source bytes and normal preview/apply, then appends in place without reloading the library', async bridge => {
    const f = fixture({ bridge, context: null }), bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 19);
    try {
      expect(f.dom.window.document.querySelector('input[type=file]')?.hasAttribute('multiple')).toBe(true);
      f.choose(['widget-video.mp4'], bytes, 'video/mp4'); expect(f.calls).toHaveLength(0);
      f.click('[data-upload-start]');
      await vi.waitFor(() => expect(f.dom.window.document.querySelector('main')!.textContent).toContain('saved to your library'));
      await vi.waitFor(() => expect(f.calls.at(-1)?.tool).toBe('media_get'));
      const prepared = f.calls.filter(call => call.tool === 'media_prepare_upload'); expect(prepared).toHaveLength(2);
      expect(prepared[0]?.args).toEqual({ name: 'widget-video.mp4', content_type: 'video/mp4', byte_length: bytes.length, sha256: sha(bytes), project_id: project });
      expect(prepared[1]?.args).toEqual({ ...prepared[0]!.args, pending_operation_id: 'pending-1' });
      expect(f.calls.filter(call => call.tool === 'media_finalize_upload')).toHaveLength(2);
      expect(f.transfers).toHaveLength(1); expect(f.transfers[0]).toMatchObject({ method: 'PUT', headers: { 'content-type': 'video/mp4', 'x-upsert': 'false', 'cache-control': 'max-age=0' }, credentials: false });
      expect(Buffer.from(f.transfers[0]!.bytes as ArrayBuffer).equals(bytes)).toBe(true); expect(f.transfers[0]!.headers).not.toHaveProperty('authorization');
      expect(f.calls.every(call => call.args.project_id === project)).toBe(true);
      expect(f.dom.window.document.querySelector('main')!.textContent).not.toContain('temporary');
      expect(f.dom.window.document.querySelector('.creative-name')?.textContent).toBe('widget-video.mp4');
      expect(f.calls.some(call=>call.tool==='media_list')).toBe(false);
      await vi.waitFor(() => expect(f.messages.some(message => message.method === 'ui/update-model-context')).toBe(true));
      const context = f.messages.find(message => message.method === 'ui/update-model-context').params.structuredContent;
      expect(context.adport_uploads).toMatchObject({ project_id: project, files: [{ status: 'READY', sha256: sha(bytes) }] });
      expect(JSON.stringify(context)).not.toMatch(/temporary|pending_operation_id|upload_url/);
    } finally { f.dom.window.close(); }
  });

  it('accepts a multi-file drop, runs two transfers at most, and never navigates away', async () => {
    const f = fixture({existing:true});
    try {
      const video=f.dom.window.document.querySelector('video')!,card=video.closest('article');video.currentTime=7;
      f.choose(['one.png', 'two.png', 'three.png'], undefined, undefined, true); expect(f.calls).toHaveLength(0);
      f.click('[data-upload-start]'); f.click('[data-upload-start]');
      await vi.waitFor(() => expect(f.dom.window.document.querySelector('[data-upload-start]')).toBeNull());
      await vi.waitFor(()=>expect(f.dom.window.document.querySelector('main')!.textContent).toContain('3 saved to your library'));
      expect(f.maxActive()).toBe(2); expect(f.transfers).toHaveLength(3);
      expect(f.dom.window.document.querySelector('video')).toBe(video);expect(video.closest('article')).toBe(card);expect(video.currentTime).toBe(7);
      expect(f.dom.window.document.querySelectorAll('article')).toHaveLength(4);
      expect(f.calls.filter(call => call.tool === 'media_prepare_upload' && call.args.pending_operation_id)).toHaveLength(3);
      expect(f.dom.window.location.href).toBe('https://widget.example/');
    } finally { f.dom.window.close(); }
  });

  it.each([`${storage}/storage/v1/object/upload/sign/creative-media/${otherProject}/ID?token=x`, 'https://foreign.example/upload?token=x', `${storage}/wrong/path?token=x`])('rejects a changed upload destination before transmitting bytes: %s', async destination => {
    const f = fixture({ destination: id => destination.replace('ID', id) });
    try {
      f.choose(['private.png']); f.click('[data-upload-start]');
      await vi.waitFor(() => expect(f.dom.window.document.querySelector('main')!.textContent).toContain('No bytes were sent.'));
      expect(f.transfers).toHaveLength(0); expect(f.calls.some(call => call.tool === 'media_finalize_upload')).toBe(false);
    } finally { f.dom.window.close(); }
  });

  it.each([{ transferError: true }, { finalError: true }])('reconciles an unknown outcome without replaying transfer or apply: %o', async options => {
    const f = fixture(options);
    try {
      f.choose(['private.png']); f.click('[data-upload-start]');
      await vi.waitFor(() => expect(f.dom.window.document.querySelector('[data-upload-verify]')?.hasAttribute('disabled')).toBe(false));
      const writes = f.calls.filter(call => call.args.pending_operation_id).length;
      f.click('[data-upload-verify]');
      await vi.waitFor(() => expect(f.dom.window.document.querySelector('main')!.textContent).toContain('saved to your library'));
      expect(f.transfers).toHaveLength(1); expect(f.calls.filter(call => call.args.pending_operation_id)).toHaveLength(writes);
      expect(f.calls.filter(call => call.tool === 'media_get')).toHaveLength(1);
    } finally { f.dom.window.close(); }
  });

  it('hides upload for read-only or conflicting project context and rejects unsupported/oversized files before any call', () => {
    for (const options of [{ readOnly: true }, { context: otherProject }]) {
      const f = fixture(options); expect(f.dom.window.document.querySelector('input[type=file]')).toBeNull(); f.dom.window.close();
    }
    const f = fixture({ maxBytes: 1 });
    try {
      f.choose(['oversized.png']); expect(f.dom.window.document.querySelector('[data-upload-start]')).toBeNull();
      expect(f.dom.window.document.querySelector('main')!.textContent).toContain('within the size limit'); expect(f.calls).toHaveLength(0);
    } finally { f.dom.window.close(); }
  });

  it('keeps host echoes of upload operations from replacing the active upload queue', async () => {
    const f = fixture();
    try {
      f.choose(['private.png']); f.click('[data-upload-start]');
      f.dom.window.dispatchEvent(new f.dom.window.MessageEvent('message', { source: f.dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'applied', applied: true, _adport: { tool: 'media_prepare_upload', view: 'operation' } } } } }));
      expect(f.dom.window.document.querySelector('[data-upload-queue]')).not.toBeNull();
      await vi.waitFor(() => expect(f.dom.window.document.querySelector('main')!.textContent).toContain('1 saved to your library'));
      f.dom.window.dispatchEvent(new f.dom.window.MessageEvent('message', { source: f.dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'applied', applied: true, _adport: { tool: 'media_finalize_upload', view: 'operation' } } } } }));
      expect(f.dom.window.document.querySelector('[data-media-gallery]')).not.toBeNull();
    } finally { f.dom.window.close(); }
  });
  it('never repeats finalize after an unknown apply while the stored file is still processing', async () => {
    const f=fixture({finalError:true,reconcileProcessing:true});
    try {
      f.choose(['private.png']);f.click('[data-upload-start]');
      await vi.waitFor(()=>expect(f.dom.window.document.querySelector('[data-upload-verify]')?.hasAttribute('disabled')).toBe(false));
      const before=f.calls.length;f.click('[data-upload-verify]');
      await vi.waitFor(()=>expect(f.dom.window.document.querySelector('main')!.textContent).toContain('No bytes were resent'));
      expect(f.calls.slice(before).map(call=>call.tool)).toEqual(['media_get']);
      expect(f.transfers).toHaveLength(1);
    } finally {f.dom.window.close();}
  });

  it('does not offer a resend or repeat an uncertain reservation apply', async () => {
    const f=fixture({prepareError:true});
    try {
      f.choose(['private.png']);f.click('[data-upload-start]');
      await vi.waitFor(()=>expect(f.dom.window.document.querySelector('main')!.textContent).toContain('Unknown reservation outcome'));
      expect(f.dom.window.document.querySelector('[data-upload-start],[data-upload-verify]')).toBeNull();
      expect(f.calls.filter(call=>call.args.pending_operation_id)).toHaveLength(1);expect(f.transfers).toHaveLength(0);
    } finally {f.dom.window.close();}
  });

  it('keeps an in-flight transfer bound to its captured project when the host changes project', async () => {
    const f=fixture();
    try {
      f.choose(['private.png']);f.click('[data-upload-start]');
      f.dom.window.dispatchEvent(new f.dom.window.MessageEvent('message',{source:f.dom.window.parent,data:{jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:structuredResult('media_list','creatives',{creatives:[],upload_config:{...config,project_id:otherProject}},undefined,{project_id:otherProject},{can_write:true})}}}));
      await vi.waitFor(()=>expect(f.messages.some(message=>message.method==='ui/update-model-context')).toBe(true));
      expect(f.calls.every(call=>call.args.project_id===project)).toBe(true);
      expect(f.dom.window.document.querySelector('article')).toBeNull();
      expect(f.messages.find(message=>message.method==='ui/update-model-context').params.structuredContent.adport_uploads.project_id).toBe(project);
    } finally {f.dom.window.close();}
  });

  it('bounds the queue and validates extension fallback and empty files before sending anything', () => {
    const f=fixture();
    try {
      f.choose(['no-type.png'],Buffer.from('bytes'),'');
      f.choose(['empty.png'],Buffer.alloc(0));
      f.choose(Array.from({length:60},(_,i)=>`image${i}.png`));
      expect(f.dom.window.document.querySelectorAll('.widget-upload-row')).toHaveLength(50);
      expect(f.dom.window.document.querySelector('main')!.textContent).toContain('up to 50 files');
      expect(f.dom.window.document.querySelector('[data-upload-start]')?.textContent).toBe('Upload 49 files');
      expect(f.calls).toHaveLength(0);expect(f.transfers).toHaveLength(0);
    } finally {f.dom.window.close();}
  });

});
