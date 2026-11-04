import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProviderConnections, type ConnectionView } from '@/app/dashboard/connections/provider-connections';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const connection: ConnectionView = {
  provider: 'google', status: 'connected', externalLabel: '2 accessible Google Ads account(s)',
  connectedAt: '2026-08-31T12:00:00Z', lastVerifiedAt: null, lastError: null,
};

function render(options: { canManage?: boolean; available?: boolean; connections?: ConnectionView[]; returnTo?: string } = {}) {
  return renderToStaticMarkup(<ProviderConnections organizationId="org" canManage={options.canManage ?? true}
    connections={options.connections ?? [connection]} returnTo={options.returnTo}
    oauthProviders={OAUTH_PROVIDERS.map(id => ({ id, available: options.available ?? true }))} />);
}

describe('compact provider connection list', () => {
  it('offers Pin management separately and preserves an enabled opt-in on reconnection', () => {
    const pinterest = { ...connection, provider: 'pinterest', status: 'error' as const };
    const basic = render({ connections: [pinterest] });
    expect(basic).toContain('Authorize Pinterest public board, Pin and media management with additional permissions');
    expect(basic).not.toContain('secret_pins=1');
    expect(basic).toContain('/api/oauth/pinterest/start?organization_id=org&amp;pin_management=1');
    const enabled = render({ connections: [{ ...pinterest, pinManagementEnabled: true }] });
    expect(enabled).not.toContain('Enable Pin management');
    expect(enabled).toContain('/api/oauth/pinterest/start?organization_id=org&amp;pin_management=1');
    expect(render({ connections: [pinterest], canManage: false })).not.toContain('Enable Pin management');
  });
  it('offers secret content separately from a public grant and retains it on reconnect', () => {
    const pinterest = { ...connection, provider: 'pinterest', pinManagementEnabled: true };
    const publicOnly = render({ connections: [pinterest] });
    expect(publicOnly).toContain('four additional private-content permissions');
    expect(publicOnly).toContain('pin_management=1&amp;secret_pins=1');
    const secret = render({ connections: [{ ...pinterest, secretPinsEnabled: true }] });
    expect(secret).not.toContain('Enable secret Pin management');
    expect(secret).not.toContain('pin_management=1');
    expect(secret).toContain('/api/oauth/pinterest/start?organization_id=org&amp;secret_pins=1');
    expect(render({ connections: [pinterest], canManage: false })).not.toContain('Enable secret Pin management');
    expect(render({ connections: [{ ...pinterest, accountSelectionId: 'pending' }] })).not.toContain('Enable secret Pin management');
  });
  it('offers conversion permission separately and retains it on later Google reconnection', () => {
    const basic = render();
    expect(basic).toContain('Authorize Google conversion imports with additional Data Manager permission');
    expect(basic).toContain('/api/oauth/google/start?organization_id=org&amp;data_manager=1');
    const enabled = render({ connections: [{ ...connection, dataManagerEnabled: true }] });
    expect(enabled).not.toContain('Enable conversion imports');
    expect(enabled).toContain('/api/oauth/google/start?organization_id=org&amp;data_manager=1');
    expect(render({ canManage: false })).not.toContain('Enable conversion imports');
  });
  it('renders every provider as a list row without card descriptions or OAuth flow details', () => {
    const html = render();
    expect(html.match(/class="connection-row"/g)).toHaveLength(11);
    expect(html).toContain('role="list"');
    expect(html).not.toContain('connection-grid');
    expect(html).not.toContain('connection-copy');
    expect(html).not.toContain('>Flow<');
    expect(html).toContain('2 accounts');
    expect(html).toContain('/dashboard/accounts?select_provider=google');
    expect(html).toContain('Connection details for Google Ads');
  });

  it.each([['0', '0 accounts'], ['1', '1 account'], ['12', '12 accounts']])('shows an accurate %s-account summary', (count, expected) => {
    expect(render({ connections: [{ ...connection, externalLabel: `${count} accessible Google Ads account(s)` }] })).toContain(expected);
  });

  it('preserves custom labels and handles missing labels', () => {
    expect(render({ connections: [{ ...connection, externalLabel: 'Agency account' }] })).toContain('Agency account');
    expect(render({ connections: [{ ...connection, externalLabel: null }] })).toContain('View accounts');
  });

  it('keeps tenant binding and onboarding return path in OAuth links', () => {
    const html = render({ returnTo: '/onboarding' });
    expect(html).toContain('/api/oauth/linkedin/start?organization_id=org&amp;return_to=%2Fonboarding');
    expect(html).toContain('aria-label="Connect LinkedIn Ads"');
    expect(html).toContain('aria-label="Disconnect Google Ads"');
  });

  it('keeps error details visible and offers reconnection', () => {
    const html = render({ connections: [{ ...connection, status: 'error', lastError: 'Access expired. Reconnect.' }] });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Access expired. Reconnect.');
    expect(html).toContain('>Reconnect</a>');
    expect(html).not.toContain('/dashboard/accounts?select_provider=google');
  });

  it('offers reconnection for revoked grants without implying healthy access', () => {
    const html = render({ connections: [{ ...connection, status: 'revoked' }] });
    expect(html).toContain('>Reconnect</a>');
    expect(html).toContain('Reconnect to verify');
  });

  it('restarts an unavailable selection instead of sending users back to an expired link', () => {
    const html = render({ connections: [{ ...connection, accountSelectionId: 'expired-fixture', accountSelectionUnavailable: true }] });
    expect(html).toContain('Restart selection for Google Ads');
    expect(html).toContain('/api/oauth/google/start?organization_id=org');
    expect(html).not.toContain('/account-selection?selection_id=expired-fixture');
  });

  it('does not expose management actions to members', () => {
    const html = render({ canManage: false });
    expect(html).not.toContain('/api/oauth/');
    expect(html).not.toContain('>Disconnect</button>');
    expect(html.match(/Owners and admins manage connections/g)).toHaveLength(1);
  });

  it('hides unavailable unconnected platforms while retaining existing connections and disconnect', () => {
    const html = render({ available: false });
    expect(html).not.toContain('LinkedIn Ads');
    expect(html).toContain('Google Ads');
    expect(html).not.toContain('/api/oauth/');
    expect(html).toContain('>Disconnect</button>');
  });

  it('explains how to continue when no platforms can be connected', () => {
    const html = render({ available: false, connections: [] });
    expect(html).toContain('Platform connections are temporarily unavailable');
    expect(html).toContain('finish setup now');
    expect(html).not.toContain('connection-list-heading');
  });
});
