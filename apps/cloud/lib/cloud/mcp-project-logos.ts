import 'server-only';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';

/** Call only with projects selected by the caller's existing membership/grant. */
export async function mcpProjectLogoUrls(projects: Array<{ id: string; logoPath: string | null }>): Promise<Map<string, string>> {
  const paths = projects.flatMap(project => {
    const parts = project.logoPath?.split('/');
    return parts?.length === 3 && parts[0] === 'project' && parts[1] === project.id
      && parts[2]!.endsWith('.png') && z.string().uuid().safeParse(parts[2]!.slice(0, -4)).success
      ? [project.logoPath!] : [];
  });
  if (!paths.length) return new Map();
  try {
    const { data, error } = await createAdminClient().storage.from('workspace-logos').createSignedUrls(paths, 15 * 60);
    if (error) return new Map();
    return new Map((data ?? []).flatMap(item => item.path && paths.includes(item.path) && !item.error && item.signedUrl
      ? [[item.path, item.signedUrl]] : []));
  } catch { return new Map(); }
}
