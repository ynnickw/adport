type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

/** Preserve the documented machine diagnostics, never free-form messages or input values. */
export async function linkedinErrorDetails(response: Response, secrets: readonly (string | undefined)[]): Promise<Row> {
  const details: Row = { http_status: response.status };
  const safe = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value) && !secrets.some(secret => secret && value.includes(secret)) ? value : undefined;
  const requestId = safe(response.headers.get('x-li-uuid') ?? response.headers.get('x-li-request-id'), /^[A-Za-z0-9._:+/=-]{1,200}$/);
  if (requestId) details.request_id = requestId;
  let body: Row;
  try {
    const reader = response.body?.getReader(); if (!reader) return details;
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 32 * 1024) { await reader.cancel(); return details; }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    body = row(JSON.parse(new TextDecoder().decode(bytes)));
  } catch { return details; }
  const code = safe(body.code, /^[A-Z][A-Z0-9_]{0,99}$/);
  if (code) details.native_code = code;
  if (typeof body.serviceErrorCode === 'number' && Number.isSafeInteger(body.serviceErrorCode) && body.serviceErrorCode >= 0) details.service_error_code = body.serviceErrorCode;
  const errors = row(body.errorDetails), collected: Row[] = [];
  for (const [key, conditional] of [['inputErrors', false], ['conditionalInputErrors', true]] as const) {
    const values = errors[key]; if (!Array.isArray(values)) continue;
    for (const value of values.slice(0, 20)) {
      const error = row(value), path = row(row(error.input).inputPath), nativeCode = safe(error.code, /^[A-Z][A-Z0-9_]{0,99}$/);
      const field = safe(path.fieldPath ?? path.parameterPath, /^\/[A-Za-z][A-Za-z0-9_/.:[\]-]{0,255}$/);
      if (!nativeCode && !field) continue;
      const item: Row = { conditional, ...(nativeCode ? { code: nativeCode } : {}), ...(field ? { field_path: field } : {}) };
      for (const bound of ['minValue','maxValue']) { const number = error[bound]; if (typeof number === 'string' && /^-?\d{1,50}(?:\.\d{1,50})?$/.test(number)) item[bound === 'minValue' ? 'min_value' : 'max_value'] = number; }
      for (const length of ['minLength','maxLength']) { const number = error[length]; if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) item[length === 'minLength' ? 'min_length' : 'max_length'] = number; }
      collected.push(item);
    }
  }
  if (collected.length) details.input_errors = collected;
  return details;
}
