import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

let rendering = 0;

/** Isolate untrusted parsing so a bounded timeout can terminate it. */
export async function pdfCover(bytes: Uint8Array): Promise<Uint8Array> {
  if (rendering >= 2) throw new Error('Preview renderer is busy');
  rendering++;
  try {
    const workerPath = (process.env.NODE_ENV === 'production'
      ? [resolve('.pdf-renderer/worker.mjs'), resolve('apps/cloud/.pdf-renderer/worker.mjs')]
      : [resolve('lib/cloud/pdf-cover-worker.mjs'), resolve('apps/cloud/lib/cloud/pdf-cover-worker.mjs')]).find(existsSync);
    if (!workerPath) throw new Error('Preview renderer unavailable');
    return await new Promise<Uint8Array>((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: bytes, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Preview rendering timed out')); }, 8000);
      const stop = () => { clearTimeout(timer); void worker.terminate(); };
      worker.once('message', (result: { image?: Uint8Array }) => {
        stop();
        if (result.image?.length) resolve(result.image); else reject(new Error('Document preview unavailable'));
      });
      worker.once('error', () => { stop(); reject(new Error('Document preview unavailable')); });
      worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Document preview unavailable')); });
    });
  } finally { rendering--; }
}
