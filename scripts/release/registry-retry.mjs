import { setTimeout as sleep } from 'node:timers/promises';

export const registryWaitMs = 15 * 60 * 1000;
export const registryFetchArgs = ['--registry=https://registry.npmjs.org', '--userconfig=/dev/null', '--prefer-online', '--fetch-retries=0', '--fetch-timeout=15000'];
const transientCodes = new Set(['E408', 'E425', 'E429', 'E500', 'E502', 'E503', 'E504', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']);

export function npmErrorCode(result) {
  try {
    const code = JSON.parse(result.stdout).error?.code;
    if (code) return code;
  } catch { /* npm does not emit JSON for every failure. */ }
  return result.error?.code ?? /npm (?:error|ERR!) code (\S+)/.exec(result.stderr ?? '')?.[1] ?? /\[(E[A-Z0-9_]+)\]/.exec(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)?.[1];
}

export function registryCommandError(result, action, { missingIsTransient = false } = {}) {
  const code = npmErrorCode(result);
  return Object.assign(new Error(`${action} failed (${code ?? `exit ${result.status ?? result.signal ?? 'unknown'}`}).`), {
    code,
    retryable: transientCodes.has(code) || (missingIsTransient && ['E404', 'ETARGET'].includes(code)),
  });
}

export function isExistingVersionConflict(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return ['E409', 'E403'].includes(npmErrorCode(result)) && /cannot publish over (?:the )?previously (?:staged|published) versions?\b/i.test(output);
}

export async function retryRegistry(operation, {
  description,
  timeoutMs = registryWaitMs,
  now = Date.now,
  wait = sleep,
  log = console.log,
} = {}) {
  const deadline = now() + timeoutMs;
  let delay = 2000;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!error.retryable) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for ${description}. Retry the same immutable tag after checking npm registry availability.`, { cause: error });
      }
      const pause = Math.min(delay, remaining);
      log(`Waiting for ${description}: ${error.message} Retrying in ${pause / 1000}s (${Math.ceil(remaining / 1000)}s remaining).`);
      await wait(pause);
      delay = Math.min(delay * 2, 30000);
    }
  }
}
