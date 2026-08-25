const hasDatabaseEnvironment = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL
  && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  && process.env.SUPABASE_SECRET_KEY
  && process.env.SUPABASE_DB_URL,
);

if (hasDatabaseEnvironment) process.env.ADPORT_RUN_DATABASE_TESTS ??= '1';

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://example.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-publishable-key-000000000000';
process.env.SUPABASE_SECRET_KEY ??= 'test-secret-key-0000000000000000';
process.env.SUPABASE_DB_URL ??= 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
process.env.ADPORT_CLOUD_BASE_URL ??= 'https://app.adport.test';
process.env.ADPORT_CLOUD_ENCRYPTION_KEY ??= 'dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcyEhISE=';
process.env.ADPORT_API_KEY_PEPPER ??= 'test-api-key-pepper-00000000000000000000000000000000';
process.env.ADPORT_MCP_OAUTH_SIGNING_KEY ??= 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
