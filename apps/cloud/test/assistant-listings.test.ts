import { expect, it } from 'vitest';
import { approvedAssistantListings } from '@/lib/assistant-listings';

it('uses manual setup without an approved listing on a self-hosted deployment', () => {
  expect(approvedAssistantListings({})).toEqual({});
  expect(approvedAssistantListings({ claude: 'https://claude.ai/directory/test', chatgpt: 'https://chatgpt.com/plugins/test' })).toEqual({ claude: 'https://claude.ai/directory/test', chatgpt: 'https://chatgpt.com/plugins/test' });
});
it('uses the production plugin only on Adport Cloud unless an approved listing is configured', () => {
  expect(approvedAssistantListings({ baseUrl: 'https://app.adport.dev/' }).chatgpt).toBe('https://chatgpt.com/plugins/plugin_asdk_app_6ac8e34c80f88191ab5020c82b00e652');
  expect(approvedAssistantListings({ baseUrl: 'https://app.adport.dev.example.com' })).toEqual({});
  expect(approvedAssistantListings({ baseUrl: 'https://app.adport.dev', chatgpt: 'https://chatgpt.com/plugins/override' }).chatgpt).toBe('https://chatgpt.com/plugins/override');
});
it.each(['http://claude.ai/directory/test', 'https://claude.ai.evil.test/directory/test', 'https://claude.ai@evil.test/test', 'javascript:alert(1)', 'https://claude.ai/', 'https://claude.ai:8443/test'])('rejects unsafe or unusable listing: %s', claude => {
  expect(approvedAssistantListings({ claude })).toEqual({});
});

import { matchesAssistant } from '@/lib/assistant-client';
it('distinguishes clients from the same provider and requires generic setup for keys', () => {
  const oauth = { kind: 'oauth', clientUri: null };
  expect(matchesAssistant('claude', { ...oauth, clientName: 'Claude Code' })).toBe(false);
  expect(matchesAssistant('claude-code', { ...oauth, clientName: 'Claude Code' })).toBe(true);
  expect(matchesAssistant('chatgpt', { ...oauth, clientName: 'OpenAI Codex' })).toBe(false);
  expect(matchesAssistant('codex', { ...oauth, clientName: 'OpenAI Codex' })).toBe(true);
  expect(matchesAssistant('claude', { ...oauth, clientName: 'Custom assistant', clientUri: 'https://claude.ai' })).toBe(true);
  expect(matchesAssistant('chatgpt', { ...oauth, clientName: 'ChatGPT' })).toBe(true);
  expect(matchesAssistant('claude', { kind: 'key', clientName: 'Claude', clientUri: null })).toBe(false);
  expect(matchesAssistant('mcp', { kind: 'key', clientName: 'Custom assistant', clientUri: null })).toBe(true);
});
