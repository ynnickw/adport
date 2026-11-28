export function toolAccessPath(projectId: string, connectionId: string, kind: 'oauth' | 'key', scopeId?: string): string {
  return `/dashboard/agents?${new URLSearchParams({ projectId, connection: connectionId, kind,
    ...(kind === 'oauth' ? { scope: scopeId ?? 'project' } : {}) })}#connected-assistants`;
}
