import { matomoRedirectUri } from '@/lib/cloud/matomo-oauth';
import { noStoreJson } from '@/lib/http';

/** A registration is specific to one Matomo installation, including its base path. */
export function GET(request: Request) {
  const instances = new URL(request.url).searchParams.getAll('instance');
  if (instances.length === 1 && instances[0]!.length <= 2048) {
    try { return noStoreJson({ redirect_uri: matomoRedirectUri(instances[0]!) }); } catch { /* Invalid instance URL. */ }
  }
  return noStoreJson({ error: 'Enter the public HTTPS URL of the Matomo instance.' }, 400);
}
