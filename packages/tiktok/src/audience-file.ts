import { AdportError, csvRows } from '@adport/core';
import type { z } from 'zod';
import type { calculateType } from './custom-audience-schemas.js';

/** Validate prehashed identifiers; never normalize/re-hash private source data implicitly. */
export function audienceFileRecords(bytes: Uint8Array, type: z.infer<typeof calculateType>): number {
  const invalid = () => new AdportError('INVALID_INPUT', 'Choose a nonempty UTF-8 customer file containing only the declared hashed identifier types. Single-type files have one hash per row and no header. Multiple-type files require unique hashed identifier headers; raw identifiers are not accepted.');
  const rows = csvRows(bytes, { maxRows: 100_000, maxColumns: 4 }), hashed = (value: string, length: number) => new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value);
  let lengths: number[] | undefined, count = 0;
  for (const row of rows) {
    if (type === 'MULTIPLE_TYPES' && !lengths) {
      const headers = row.map(value => value.toLowerCase()), allowed: Record<string, number> = { email_sha256: 64, phone_sha256: 64, maid_sha256: 64, maid_md5: 32 };
      if (new Set(headers).size !== headers.length || headers.some(header => !Object.hasOwn(allowed, header))) throw invalid();lengths = headers.map(header => allowed[header]!);continue;
    }
    if (type === 'MULTIPLE_TYPES' ? row.length !== lengths!.length || row.every(value => value === '') || row.some((value, index) => value !== '' && !hashed(value, lengths![index]!)) : row.length !== 1 || !hashed(row[0]!, type.endsWith('MD5') ? 32 : 64)) throw invalid();
    count++;
  }
  if (!count) throw invalid();return count;
}
