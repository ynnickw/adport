import { apiPrincipal, requireScope } from '@/lib/cloud/auth';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { apiError, noStoreJson } from '@/lib/http';
import { adWritePlanLimit } from '@/lib/cloud/write-plan-limit';
import { PlanLimitError } from '@/lib/cloud/plan-limit';
import { env } from '@/lib/env';
import { principalToolSelection } from '@/lib/cloud/tool-catalog';

export async function POST(request: Request, { params }: { params: Promise<{ tool: string }> }) {
  try {
    const principal = await apiPrincipal(request);
    const catalog = await principalToolSelection(principal);
    const runtime = await createTenantRuntime(principal, { surface: 'api', catalog });
    const { tool } = await params;
    const definition = runtime.registry.get(tool);
    if (!definition.annotations.readOnly && !principal.scopes.includes('tools:write')) {
      const limit = await adWritePlanLimit(principal, env().ADPORT_CLOUD_BASE_URL);
      if (limit) throw new PlanLimitError(limit);
    }
    requireScope(principal, definition.annotations.readOnly ? 'tools:read' : 'tools:write');
    const input = await request.json();
    return noStoreJson(await runtime.registry.call(tool, input, runtime.ctx));
  } catch (error) {
    return apiError(error);
  }
}
