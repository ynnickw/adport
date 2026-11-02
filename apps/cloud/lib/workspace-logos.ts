export type WorkspaceLogoKind = 'project' | 'organization';

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp';

export function workspaceLogoUrl(kind: WorkspaceLogoKind, id: string, path: string | null | undefined): string | null {
  return path ? `/api/workspace-logos/${kind}/${id}?v=${encodeURIComponent(path.split('/').at(-1)!)}` : null;
}
