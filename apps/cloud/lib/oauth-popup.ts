import { safeReturnPath } from './return-path';

export const POPUP_COMPLETE_PATH = '/oauth/provider-complete';
export const popupChannelName = (id: string) => `adport-provider-oauth:${id}`;
export const validPopupId = (id: unknown): id is string => typeof id === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

// Only navigation is sent between windows, never provider codes or credentials.
export function popupDestination(value: unknown): string | undefined {
  if (typeof value !== 'string' || safeReturnPath(value) !== value) return undefined;
  const url = new URL(value, 'https://adport.invalid');
  if (!['/account-selection', '/onboarding', '/dashboard/accounts', '/dashboard/connections'].includes(url.pathname)) return undefined;
  if ([...url.searchParams.keys()].some(key => !['selection_id', 'select_provider', 'error', 'connected', 'accounts_saved'].includes(key))) return undefined;
  return value;
}

export function popupReturnPath(id: string, returnPath: string): string {
  return `${POPUP_COMPLETE_PATH}?${new URLSearchParams({ popup_id: id, next: safeReturnPath(returnPath) })}`;
}

export function unwrapPopupReturnPath(path: string): { returnPath: string; popupId?: string } {
  const url = new URL(safeReturnPath(path), 'https://adport.invalid');
  const id = url.searchParams.get('popup_id');
  if (url.pathname !== POPUP_COMPLETE_PATH || !validPopupId(id)) return { returnPath: safeReturnPath(path) };
  return { popupId: id, returnPath: safeReturnPath(url.searchParams.get('next')) };
}

/** Called synchronously from a click so browser popup permission is preserved. */
export function openProviderPopup(href: string, navigate: (path: string) => void, onTimeout: () => void): (() => void) | undefined {
  if (typeof window.BroadcastChannel !== 'function' || !window.crypto?.randomUUID) return undefined;
  const id = window.crypto.randomUUID();
  let channel: BroadcastChannel;
  try { channel = new window.BroadcastChannel(popupChannelName(id)); } catch { return undefined; }
  const width = Math.min(540, window.screen.availWidth);
  const height = Math.min(740, window.screen.availHeight);
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  let popup: Window | null;
  try { popup = window.open('about:blank', `adport-oauth-${id}`, `popup=yes,width=${width},height=${height},left=${left},top=${top}`); }
  catch { channel.close(); return undefined; }
  if (!popup) { channel.close(); return undefined; }
  const url = new URL(href, window.location.origin);
  url.searchParams.set('popup_id', id);
  let timer: ReturnType<typeof setTimeout>;
  const cleanup = () => { clearTimeout(timer); channel.close(); };
  channel.onmessage = event => {
    const data = event.data;
    if (!data || data.type !== 'adport:oauth-complete' || data.popupId !== id) return;
    const destination = popupDestination(data.next);
    if (!destination) return;
    channel.postMessage({ type: 'adport:oauth-received', popupId: id });
    cleanup();
    window.focus();
    navigate(destination);
  };
  // COOP may sever Window references during consent. Do not poll popup.closed.
  timer = setTimeout(() => { cleanup(); onTimeout(); }, 10 * 60_000);
  try {
    popup.opener = null;
    popup.location.replace(url.toString());
    popup.focus();
  } catch {
    cleanup();
    popup.close();
    return undefined;
  }
  return cleanup;
}
