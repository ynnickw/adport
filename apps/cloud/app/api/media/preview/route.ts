import sharp from 'sharp';
import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { ProjectMediaLibrary } from '@/lib/cloud/media';
import { apiError, HttpError } from '@/lib/http';

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams, project = z.string().uuid().parse(query.get('project_id')), id = z.string().uuid().parse(query.get('media_id'));
    const library = new ProjectMediaLibrary(await sessionPrincipal(project)), asset = await library.get(id);
    if (!asset.content_type.startsWith('image/') || asset.status !== 'READY') throw new HttpError('Image preview unavailable.', 404);
    const file = await library.read({ media_id: id, expected_sha256: asset.sha256 });
    const bytes = await sharp(file.bytes, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/webp', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline' } });
  } catch (error) { return apiError(error); }
}
