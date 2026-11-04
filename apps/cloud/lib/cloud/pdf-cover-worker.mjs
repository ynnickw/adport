import { parentPort, workerData } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { getDocument, AnnotationMode } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('pdfjs-dist/package.json'));
let task, result;
try {
  task = getDocument({
    data: new Uint8Array(workerData), isEvalSupported: false, useSystemFonts: false,
    useWorkerFetch: false, disableFontFace: true, stopAtErrors: true, verbosity: 0,
    maxImageSize: 2_000_000, canvasMaxAreaInBytes: 8_000_000,
    cMapUrl: join(root, 'cmaps/'), cMapPacked: true,
    standardFontDataUrl: join(root, 'standard_fonts/'),
  });
  const document = await task.promise;
  const page = await document.getPage(1);
  const original = page.getViewport({ scale: 1 });
  if (!Number.isFinite(original.width) || !Number.isFinite(original.height) || original.width <= 0 || original.height <= 0) throw new Error('Invalid page');
  const viewport = page.getViewport({ scale: Math.min(512 / original.width, 640 / original.height) });
  const canvas = document.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.context, viewport, annotationMode: AnnotationMode.DISABLE }).promise;
  const image = canvas.canvas.toBuffer('image/png');
  result = { image };
  document.canvasFactory.destroy(canvas);
  page.cleanup();
} catch {
  result = { error: true };
} finally {
  await task?.destroy().catch(() => {});
  parentPort.postMessage(result);
}
