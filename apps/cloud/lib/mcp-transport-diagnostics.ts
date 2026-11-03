type RejectionPhase = 'transport' | 'request_setup';

function rejectionReason(message: unknown): string {
  if (typeof message !== 'string') return 'unknown';
  const reasons: Record<string, string> = {
    'Parse error: Invalid JSON': 'invalid_json',
    'Parse error: Invalid JSON-RPC message': 'invalid_jsonrpc',
    'Parse error': 'transport_exception',
    'Invalid Request: Only one initialization request is allowed': 'batched_initialize',
    'Invalid Request: Server already initialized': 'already_initialized',
    'Bad Request: Server not initialized': 'not_initialized',
    'Bad Request: Mcp-Session-Id header is required': 'missing_session',
    'Not Acceptable: Client must accept both application/json and text/event-stream': 'accept_json_and_sse_required',
    'Not Acceptable: Client must accept text/event-stream': 'accept_sse_required',
    'Unsupported Media Type: Content-Type must be application/json': 'json_content_type_required',
  };
  if (message.startsWith('Bad Request: Unsupported protocol version: ')) return 'unsupported_protocol';
  return reasons[message] ?? 'unknown';
}

/** Operational transport diagnostics only: never log payloads, IDs, credentials or raw errors. */
export async function diagnoseMcpRejection(request: Request, response: Response, phase: RejectionPhase = 'transport'): Promise<void> {
  if (![400, 406, 415].includes(response.status)) return;
  let reason = 'unknown';
  let rpcCode: number | undefined;
  try {
    const body: unknown = await response.clone().json();
    if (body && typeof body === 'object' && 'error' in body) {
      const error = body.error;
      if (error && typeof error === 'object') {
        if ('message' in error) reason = rejectionReason(error.message);
        if ('code' in error && typeof error.code === 'number' && Number.isSafeInteger(error.code)) rpcCode = error.code;
      }
    }
  } catch { /* Diagnostics must not alter the native response. */ }
  const protocol = request.headers.get('mcp-protocol-version');
  const accept = request.headers.get('accept') ?? '';
  console.warn(JSON.stringify({
    event: 'mcp_request_rejected',
    phase,
    status: response.status,
    reason,
    rpcCode,
    method: ['GET', 'POST', 'DELETE'].includes(request.method) ? request.method : 'other',
    protocol: protocol === null ? 'absent' : /^\d{4}-\d{2}-\d{2}$/.test(protocol) ? protocol : 'other',
    acceptsJson: accept.includes('application/json'),
    acceptsSse: accept.includes('text/event-stream'),
    jsonContentType: /^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''),
  }));
}
