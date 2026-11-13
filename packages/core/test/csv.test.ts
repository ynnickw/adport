import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { csvRows } from '../src/csv.js';
import { verifyMedia } from '../src/media.js';

const bytes = (text: string) => Buffer.from(text);
const read = (text: string) => [...csvRows(bytes(text))];
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
describe('CSV document validation', () => {
  it('preserves exact text IDs, BOM, quotes, commas, Unicode and embedded line endings', () => {
    expect(read('\ufeffsku_id,name\r\n00012,"A, B"\r\n9007199254740993,"Say ""hi""\n世界"\r\n')).toEqual([
      ['sku_id', 'name'], ['00012', 'A, B'], ['9007199254740993', 'Say "hi"\n世界'],
    ]);
    expect(read('a,b\n,""')).toEqual([['a', 'b'], ['', '']]);
  });
  it.each(['', '\ufeff', 'a,b\n1', 'a\n1,2', 'a\n"unclosed', 'a\n"closed"oops', 'a\na"b', 'a\r1', 'a\n\x00', 'a\n' + 'x'.repeat(256 * 1024 + 1)])('rejects malformed or unbounded input %#', value => {
    expect(() => read(value)).toThrow('UTF-8 CSV');
  });
  it('rejects invalid UTF-8 and enforces bounded rows/columns without truncation', () => {
    expect(() => [...csvRows(new Uint8Array([0xc3, 0x28]))]).toThrow('UTF-8 CSV');
    expect(() => [...csvRows(bytes('a\nb\nc'), { maxRows: 2 })]).toThrow('UTF-8 CSV');
    expect(() => [...csvRows(bytes('a,b'), { maxColumns: 1 })]).toThrow('UTF-8 CSV');
    expect(() => read('a\n' + '界'.repeat(90_000))).toThrow('UTF-8 CSV');
  });
  it('requires explicit CSV intent and retains checksum/MIME restrictions after a rename', () => {
    const value = bytes('sku_id\r\n00012\r\n');
    expect(() => verifyMedia(value, 'unknown.txt', hash(value))).toThrow('supported media');
    expect(verifyMedia(value, 'products.CSV', hash(value))).toMatchObject({ contentType: 'text/csv', bytes: value });
    expect(verifyMedia(value, 'Renamed products', hash(value), { contentType: 'text/csv' }).contentType).toBe('text/csv');
    expect(() => verifyMedia(value, 'products.csv', hash(value), { contentTypes: ['image/png'] })).toThrow('supported media');
    expect(() => verifyMedia(value, 'products.csv', '0'.repeat(64))).toThrow('SHA-256');
  });
});
