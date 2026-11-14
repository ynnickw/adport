import { apiPrincipal, requireScope } from '@/lib/cloud/auth';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { principalToolSelection } from '@/lib/cloud/tool-catalog';
import { apiError, noStoreJson } from '@/lib/http';

export async function GET(request: Request) {
  try {
    const principal = await apiPrincipal(request);
    requireScope(principal, 'tools:read');
    const catalog = await principalToolSelection(principal);
    const runtime = await createTenantRuntime(principal, { surface: 'api', catalog });
    return noStoreJson(await runtime.registry.call('accounts_list', {}, runtime.ctx));
  } catch (error) {
    return apiError(error);
  }
}
