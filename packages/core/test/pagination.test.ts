import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, nextPageArguments } from '../src/tools/registry.js';

const tool = defineTool({ name: 'gallery', namespace: 'test', description: 'Test gallery',
  input: z.object({ account_id: z.string(), cursor: z.string().min(1).optional(), limit: z.number().int().positive() }),
  annotations: { readOnly: true }, pagination: { cursorInput: 'cursor' }, handler: async () => ({}),
});
describe('shared read-only pagination', () => {
  it('preserves the original selection and ignores scope overrides in native output', () => {
    const args = { account_id: 'a1', project_id: 'p1', limit: 2, cursor: 'old', pending_operation_id: 'never-send' };
    expect(nextPageArguments(tool, args, { next_cursor: 'next', account_id: 'foreign', project_id: 'foreign' })).toEqual({ account_id: 'a1', project_id: 'p1', limit: 2, cursor: 'next' });
    expect(args.pending_operation_id).toBe('never-send');
  });
  it('uses the existing input schema for native numeric offsets without rounding IDs', () => {
    const offset = { ...tool, input: z.object({ account_id: z.string(), offset: z.number().int().min(0).max(1000) }), pagination: { cursorInput: 'offset', cursorOutput: 'next_offset' } };
    expect(nextPageArguments(offset, { account_id: 'a1', offset: 0 }, { next_offset: '20' })).toEqual({ account_id: 'a1', offset: 20 });
    expect(nextPageArguments(offset, { account_id: 'a1', offset: 0 }, { next_offset: 20 })).toEqual({ account_id: 'a1', offset: 20 });
    expect(nextPageArguments(offset, { account_id: 'a1', offset: 0 }, { next_offset: '9007199254740993' })).toBeUndefined();
    expect(nextPageArguments(tool, { account_id: 'a1', limit: 2 }, { next_cursor: '9007199254740993' })?.cursor).toBe('9007199254740993');
  });
  it('never enables pagination for a write, reserved scope field, invalid cursor or non-advancing cursor', () => {
    const args = { account_id: 'a1', limit: 2, cursor: 'same' };
    for (const value of ['', 'same', null, {}, 1.5, NaN]) expect(nextPageArguments(tool, args, { next_cursor: value })).toBeUndefined();
    expect(nextPageArguments({ ...tool, annotations: { readOnly: false } }, args, { next_cursor: 'next' })).toBeUndefined();
    for (const key of ['account_id', 'project_id', 'pending_operation_id', '__proto__']) expect(nextPageArguments({ ...tool, pagination: { cursorInput: key } }, args, { next_cursor: 'foreign' })).toBeUndefined();
    expect(nextPageArguments(tool, { ...args, limit: -1 }, { next_cursor: 'next' })).toBeUndefined();
  });
});
