import { AdportError } from './errors.js';

/** UTF-8 CSV with RFC 4180 quoting; LF is accepted alongside CRLF. No coercion of IDs. */
export function* csvRows(bytes: Uint8Array, limits: { maxRows?: number; maxColumns?: number } = {}): Generator<string[]> {
  const invalid = () => new AdportError('INVALID_INPUT', `Choose a nonempty UTF-8 CSV with consistent columns and valid quoting (up to ${limits.maxRows ?? 100_000} rows, ${limits.maxColumns ?? 256} columns and 256 KiB per field).`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid(); }
  if (!text || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw invalid();
  let row: string[] = [], field = '', quoted = false, closed = false, columns: number | undefined, rows = 0;
  const addField = () => { if (Buffer.byteLength(field, 'utf8') > 256 * 1024) throw invalid(); row.push(field); field = ''; closed = false; if (row.length > (limits.maxColumns ?? 256)) throw invalid(); };
  const finishRow = () => {
    addField(); columns ??= row.length;
    if (row.length !== columns || ++rows > (limits.maxRows ?? 100_000)) throw invalid();
    const value = row; row = []; return value;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; } else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === ',') addField();
    else if (char === '\r' || char === '\n') {
      if (char === '\r') { if (text[index + 1] !== '\n') throw invalid(); index++; }
      yield finishRow();
    } else if (closed) throw invalid();
    else if (char === '"') { if (field) throw invalid(); quoted = true; }
    else field += char;
    if (field.length > 256 * 1024) throw invalid();
  }
  if (quoted) throw invalid();
  if (field || row.length || closed) yield finishRow();
  if (!rows) throw invalid();
}
