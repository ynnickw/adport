import path from 'node:path';
import { adportHome } from '@adport/core';
import type { ProgramIO } from '../program.js';

export function credentialFilePath(): string {
  return path.join(adportHome(), 'credentials.json');
}

export function printLocalConnectionIntro(io: ProgramIO, provider: string): void {
  io.out('');
  io.out(`Local / bring-your-own ${provider} connection`);
  io.out('  • You own the provider app, API access, and credentials used below.');
  io.out('  • Adport Cloud and its hosted OAuth broker are not used.');
  io.out('  • Adport connects from this machine directly to the provider API.');
  io.out(`  • Secrets are stored locally in ${credentialFilePath()} (mode 0600).`);
  io.out('');
}

export function printLocalConnectionSaved(io: ProgramIO): void {
  io.out(`Credentials saved locally: ${credentialFilePath()} (mode 0600).`);
  io.out('Adport Cloud received no credentials. Remove the local copy with `adport disconnect <provider>`.');
  io.out('To invalidate an issued token or key, revoke it separately at the provider.');
}
