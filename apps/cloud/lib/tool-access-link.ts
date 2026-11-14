export function toolAccessPath(projectId: string, connectionId: string, kind: 'oauth' | 'key', organizationGroupId?: string): string {
  return `/dashboard/agents?${new URLSearchParams({ projectId, connection: connectionId, kind,
    ...(kind === 'oauth' ? { scope: organizationGroupId ?? 'project' } : {}) })}#connected-assistants`;
}
