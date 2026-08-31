import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderLogo } from '@/components/logos';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';

describe('shared provider branding', () => {
  it.each([
    ['spotify', '#1ed760'],
    ['pinterest', '#e60023'],
    ['linkedin', '#0a66c2'],
    ['x', '#000'],
  ])('keeps %s brand color independent of inherited text color', (name, color) => {
    const html = renderToStaticMarkup(<ProviderLogo name={name} />);
    expect(html).toContain(`color="${color}"`);
    expect(html).toContain('aria-hidden="true"');
  });

  it('uses the two-tone official Snapchat ghost, not a solid silhouette', () => {
    const html = renderToStaticMarkup(<ProviderLogo name="snapchat" />);
    expect(html).toContain('viewBox="0 0 1024 1024"');
    expect(html).toContain('fill="#fff"');
    expect(html).toContain('fill="#000"');
  });

  it.each(OAUTH_PROVIDERS)('renders a real logo for %s', (name) => {
    const html = renderToStaticMarkup(<ProviderLogo name={name} />);
    expect(html).toContain('<svg');
    expect(html).not.toContain('demo-logo');
  });
});
