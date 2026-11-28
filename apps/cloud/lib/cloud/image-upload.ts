import 'server-only';
import sharp, { type Sharp } from 'sharp';
import { HttpError } from '@/lib/http';
import { IMAGE_UPLOAD_FORMATS } from '@/lib/image-upload';

function sizeError(maxBytes: number) {
  return `Choose an image up to ${maxBytes / (1024 * 1024)} MB.`;
}

export async function readImageUploadForm(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data;') || !request.body) throw new HttpError('Choose an image to upload.', 400);
  const limit = maxBytes + 65_536;
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(sizeError(maxBytes), 413);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(sizeError(maxBytes), 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    return await new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } }).formData();
  } catch { throw new HttpError('The upload could not be read. Please try again.', 400); }
}

export async function normalizeUploadedImage(file: File, maxBytes: number, encode: (image: Sharp) => Promise<Buffer>): Promise<Buffer> {
  if (!file.size || file.size > maxBytes) throw new HttpError(sizeError(maxBytes), 400);
  const expectedFormat = Object.hasOwn(IMAGE_UPLOAD_FORMATS, file.type)
    ? IMAGE_UPLOAD_FORMATS[file.type as keyof typeof IMAGE_UPLOAD_FORMATS] : undefined;
  if (!expectedFormat) throw new HttpError('Choose a PNG, JPG, or WebP image.', 400);
  try {
    const image = sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 16_777_216, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== expectedFormat || (metadata.pages ?? 1) !== 1) throw new Error('Unsupported image');
    return await encode(image.autoOrient());
  } catch {
    throw new HttpError('This image could not be read. Choose a valid PNG, JPG, or WebP image.', 400);
  }
}
