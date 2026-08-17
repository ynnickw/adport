import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export default async function HomePage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return (
    <main className="shell hero">
      <div>
        <p>Adport Cloud</p>
        <h1>Your paid media control plane.</h1>
        <p>Connect Google, Meta, TikTok, Apple, Microsoft, and Reddit Ads, inspect performance from your dashboard or AI client, and keep every write behind a reviewable two-step approval.</p>
        <Link className="button" href={data.user ? '/dashboard' : '/login'}>
          {data.user ? 'Open dashboard' : 'Create an account'}
        </Link>
      </div>
    </main>
  );
}
