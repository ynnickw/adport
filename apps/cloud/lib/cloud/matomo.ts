import 'server-only';
import { lookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as fetchPublic } from 'undici';
import { AdportError } from '@adport/core';
import { MatomoClient, MatomoProvider, normalizeMatomoUrl, type MatomoCredentials, type MatomoBearerCredentials } from '@adport/provider-matomo';

function publicAddress(address: string): boolean {
  const ip = ipaddr.parse(address);
  return ip.range() === 'unicast' && (ip.kind() === 'ipv4' || (ip as ipaddr.IPv6).match(ipaddr.IPv6.parse('2000::'), 3));
}

// Validate the records used to open the socket, including after a reconnect.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, records) => {
    if (error) return callback(error, []);
    if (!records.length || records.some(record => !publicAddress(record.address))) {
      return callback(new Error('Matomo must use a public network address.'), []);
    }
    const [first] = records;
    if (options.all) callback(null, records);
    else callback(null, first!.address, first!.family);
  });
};
const dispatcher = new Agent({ connect: { lookup: publicLookup }, maxResponseSize: 16 * 1024 * 1024 });

export function hostedMatomoUrl(value: string): string {
  const url = new URL(normalizeMatomoUrl(value));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // Node skips the resolver for literal addresses.
  if (!hostname.includes('.') || hostname.endsWith('.') || isIP(hostname)) {
    throw new AdportError('INVALID_INPUT', 'Enter the HTTPS domain of a publicly reachable Matomo instance.');
  }
  return normalizeMatomoUrl(url.href);
}

export function matomoFetch(input: string, init: { body: URLSearchParams; headers: Record<string, string>; method: 'POST'; redirect: 'error'; signal: AbortSignal }) {
  return fetchPublic(input, { ...init, dispatcher, headers: { ...init.headers, 'accept-encoding': 'identity' } });
}

export function createHostedMatomoProvider(credentials: MatomoCredentials | MatomoBearerCredentials) {
  hostedMatomoUrl(credentials.url);
  return new MatomoProvider(new MatomoClient(credentials, matomoFetch));
}
