import 'server-only';
import postgres from 'postgres';
import { env } from '@/lib/env';

let client: ReturnType<typeof postgres> | undefined;

export function db() {
  client ??= postgres(env().SUPABASE_DB_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    connection: { application_name: 'adport-cloud', role: env().ADPORT_DB_ROLE },
    // Transform SQL column names only. postgres.camel's value transform also
    // rewrites JSON object keys, which would corrupt snake_case policy data.
    transform: { column: postgres.camel.column },
  });
  return client;
}

export async function closeDbForTests(): Promise<void> {
  if (client) await client.end({ timeout: 2 });
  client = undefined;
}
