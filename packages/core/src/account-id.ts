/** Match provider-accepted account aliases before routing or policy checks. */
export function canonicalAccountId(provider: string, value: string): string {
  let id = value.trim();
  if (provider === 'google') id = id.replace(/^customers\//, '').replaceAll('-', '');
  if (provider === 'meta') id = id.replace(/^act_/, '');
  if (['google', 'meta', 'tiktok', 'apple', 'microsoft', 'pinterest', 'linkedin'].includes(provider) && /^\d+$/.test(id)) id = id.replace(/^0+(?=\d)/, '');
  return id;
}
