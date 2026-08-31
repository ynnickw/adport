import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openProviderPopup, popupDestination, popupReturnPath, unwrapPopupReturnPath } from '@/lib/oauth-popup';

const id = '11111111-1111-4111-8111-111111111111';
let channels: FakeChannel[];
class FakeChannel {
  onmessage?: (event: { data: unknown }) => void;
  close = vi.fn();
  postMessage = vi.fn();
  constructor(public name: string) { channels.push(this); }
}
const popup = { opener: {}, location: { replace: vi.fn() }, focus: vi.fn(), close: vi.fn() };
const navigate = vi.fn();
const timeout = vi.fn();
const open = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); channels = []; open.mockReturnValue(popup);
  vi.stubGlobal('window', { BroadcastChannel: FakeChannel, crypto: { randomUUID: () => id },
    screen: { availWidth: 1440, availHeight: 900 }, screenX: 0, screenY: 0, outerWidth: 1440, outerHeight: 900,
    open, focus: vi.fn(), location: { origin: 'https://app.adport.test' } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('provider popup navigation', () => {
  it('persists the original destination with a per-attempt channel', () => {
    const path = popupReturnPath(id, '/onboarding');
    expect(unwrapPopupReturnPath(path)).toEqual({ popupId: id, returnPath: '/onboarding' });
    expect(unwrapPopupReturnPath('/dashboard/accounts?select_provider=x')).toEqual({ returnPath: '/dashboard/accounts?select_provider=x' });
  });
  it.each(['https://evil.test', '//evil.test', '/\\evil.test', '/api/oauth/x/start', '/oauth/provider-complete', '/account-selection?code=secret', '/dashboard/accounts?access_token=secret'])('rejects unsafe completion destinations: %s', path => {
    expect(popupDestination(path)).toBeUndefined();
  });
  it('opens a centered small window synchronously and removes its opener', () => {
    openProviderPopup('/api/oauth/x/start?organization_id=org', navigate, timeout);
    expect(open).toHaveBeenCalledWith('about:blank', `adport-oauth-${id}`, 'popup=yes,width=540,height=740,left=450,top=80');
    expect(popup.opener).toBeNull();
    expect(popup.location.replace).toHaveBeenCalledWith(`https://app.adport.test/api/oauth/x/start?organization_id=org&popup_id=${id}`);
  });
  it('accepts only its own channel result and acknowledges before navigation', () => {
    openProviderPopup('/api/oauth/x/start', navigate, timeout);
    const channel = channels[0]!;
    channel.onmessage!({ data: { type: 'adport:oauth-complete', popupId: 'wrong', next: '/onboarding' } });
    channel.onmessage!({ data: { type: 'adport:oauth-complete', popupId: id, next: 'https://evil.test' } });
    expect(navigate).not.toHaveBeenCalled();
    channel.onmessage!({ data: { type: 'adport:oauth-complete', popupId: id, next: '/account-selection?selection_id=selection' } });
    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'adport:oauth-received', popupId: id });
    expect(navigate).toHaveBeenCalledWith('/account-selection?selection_id=selection');
    expect(channel.close).toHaveBeenCalled();
    vi.advanceTimersByTime(600_000); expect(timeout).not.toHaveBeenCalled();
  });
  it('leaves ordinary navigation available when popups are blocked', () => {
    open.mockReturnValue(null);
    expect(openProviderPopup('/api/oauth/x/start', navigate, timeout)).toBeUndefined();
    expect(channels[0]!.close).toHaveBeenCalled();
  });
  it('falls back without opening a window when cross-window messaging is unavailable', () => {
    window.BroadcastChannel = undefined as never;
    expect(openProviderPopup('/api/oauth/x/start', navigate, timeout)).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });
  it('times out and cleans up, without relying on COOP-severed popup references', () => {
    openProviderPopup('/api/oauth/x/start', navigate, timeout);
    vi.advanceTimersByTime(600_000);
    expect(timeout).toHaveBeenCalledOnce(); expect(channels[0]!.close).toHaveBeenCalled();
  });
  it('cleans up its listener on unmount or retry', () => {
    const cleanup = openProviderPopup('/api/oauth/x/start', navigate, timeout)!;
    cleanup(); vi.advanceTimersByTime(600_000);
    expect(timeout).not.toHaveBeenCalled(); expect(channels[0]!.close).toHaveBeenCalled();
  });
});
