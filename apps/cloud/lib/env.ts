import 'server-only';
import { z } from 'zod';

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  SUPABASE_SECRET_KEY: z.string().min(20),
  SUPABASE_DB_URL: z.string().url(),
  ADPORT_DB_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('adport_backend'),
  ADPORT_CLOUD_BASE_URL: z.string().url(),
  ADPORT_CLOUD_ENCRYPTION_KEY: z.string().min(40),
  ADPORT_API_KEY_PEPPER: z.string().min(32),
  GOOGLE_ADS_CLIENT_ID: z.string().min(10).optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().min(8).optional(),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().min(8).optional(),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().regex(/^\d{10}$/).optional(),
  GOOGLE_OAUTH_TOKEN_URL: z.string().url().default('https://oauth2.googleapis.com/token'),
  GOOGLE_OAUTH_REVOKE_URL: z.string().url().default('https://oauth2.googleapis.com/revoke'),
});

export type CloudEnv = z.infer<typeof schema>;
export type GoogleCloudEnv = CloudEnv & {
  GOOGLE_ADS_CLIENT_ID: string;
  GOOGLE_ADS_CLIENT_SECRET: string;
  GOOGLE_ADS_DEVELOPER_TOKEN: string;
};

let parsed: CloudEnv | undefined;

export function env(): CloudEnv {
  parsed ??= schema.parse(process.env);
  return parsed;
}

export function googleEnv(): GoogleCloudEnv {
  const value = env();
  if (!value.GOOGLE_ADS_CLIENT_ID || !value.GOOGLE_ADS_CLIENT_SECRET || !value.GOOGLE_ADS_DEVELOPER_TOKEN) {
    throw new Error('Google Ads cloud OAuth is not configured. Set GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, and GOOGLE_ADS_DEVELOPER_TOKEN.');
  }
  return value as GoogleCloudEnv;
}

export function resetEnvForTests(): void {
  parsed = undefined;
}
