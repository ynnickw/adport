import os from 'node:os';
import path from 'node:path';

/**
 * All adport state (credentials, pending operations, audit log, policy) lives
 * under this directory. ADPORT_HOME overrides it — used by tests and CI.
 */
export function adportHome(): string {
  return process.env.ADPORT_HOME ?? path.join(os.homedir(), '.config', 'adport');
}
