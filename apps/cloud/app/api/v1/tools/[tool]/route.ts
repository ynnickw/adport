import { apiPrincipal, requireScope } from '@/lib/cloud/auth';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { apiError, noStoreJson } from '@/lib/http';

export async function POST(request: Request, { params }: { params: Promise<{ tool: string }> }) {
  try {
    const principal = await apiPrincipal(request);
    const runtime = await createTenantRuntime(principal);
    const { tool } = await params;
    const definition = runtime.registry.get(tool);
    requireScope(principal, definition.annotations.readOnly ? 'tools:read' : 'tools:write');
    const input = await request.json();
    return noStoreJson(await runtime.registry.call(tool, input, runtime.ctx));
  } catch (error) {
    return apiError(error);
  }
}
