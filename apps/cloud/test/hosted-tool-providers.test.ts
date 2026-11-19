import { describe, expect, it } from 'vitest';
import { toolSelectionSchema } from '../lib/mcp-tool-selection';
import { CLOUD_PROVIDERS } from '../lib/cloud/types';

describe('hosted tool platform selection', () => {
  it('accepts hosted platforms, including the API-key OpenAI connection', () => {
    expect(toolSelectionSchema.parse({ profile: 'full', providers: [...CLOUD_PROVIDERS] }).providers).toEqual([...CLOUD_PROVIDERS]);
    expect(toolSelectionSchema.safeParse({ profile: 'full', providers: ['openai'] }).success).toBe(true);
  });
});
