import { gravityClientMetadata } from '@/lib/cloud/gravity-oauth';

export function GET() {
  return Response.json(gravityClientMetadata(), { headers: { 'cache-control': 'public, max-age=300' } });
}
