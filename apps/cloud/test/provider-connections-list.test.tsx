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
  it('renders every provider as a list row without card descriptions or OAuth flow details', () => {
    const html = render();
    expect(html.match(/class="connection-row"/g)).toHaveLength(11);
    expect(html).toContain('role="list"');
    expect(html).not.toContain('connection-grid');
    expect(html).not.toContain('connection-copy');
    expect(html).not.toContain('>Flow<');
    expect(html).toContain('2 accounts');
    expect(html).toContain('/dashboard/accounts?select_provider=google');
    expect(html).toContain('Last verified:');
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

  it('does not expose management actions to members', () => {
    const html = render({ canManage: false });
    expect(html).not.toContain('/api/oauth/');
    expect(html).not.toContain('>Disconnect</button>');
    expect(html.match(/Owners and admins manage connections/g)).toHaveLength(1);
  });

  it('does not offer OAuth when a provider is unavailable, but permits disconnect', () => {
    const html = render({ available: false });
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('/api/oauth/');
    expect(html).toContain('>Disconnect</button>');
  });
});
