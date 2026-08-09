import { afterEach, describe, expect, it } from 'vitest';
import { credentialFilePath, printLocalConnectionIntro, printLocalConnectionSaved } from '../src/connect/local.js';

afterEach(() => {
  delete process.env.ADPORT_HOME;
});

describe('local provider connection messaging', () => {
  it('makes the local/BYO and Cloud boundary explicit for every provider', () => {
    process.env.ADPORT_HOME = '/tmp/adport-local-message-test';
    for (const provider of ['Google Ads', 'Meta Ads', 'TikTok Ads', 'Apple Ads', 'Microsoft Advertising']) {
      const lines: string[] = [];
      const io = { out: (line: string) => lines.push(line), err: () => undefined };
      printLocalConnectionIntro(io, provider);
      printLocalConnectionSaved(io);
      const text = lines.join('\n');
      expect(text).toContain(`Local / bring-your-own ${provider} connection`);
      expect(text).toContain('Adport Cloud and its hosted OAuth broker are not used');
      expect(text).toContain('/tmp/adport-local-message-test/credentials.json');
      expect(text).toContain('mode 0600');
      expect(text).toContain('revoke it separately at the provider');
    }
    expect(credentialFilePath()).toBe('/tmp/adport-local-message-test/credentials.json');
  });
});
