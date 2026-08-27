import { processStripeEvent, stripeClient } from '@/lib/cloud/billing';
import { env } from '@/lib/env';

export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');
  const webhookSecret = env().STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) return Response.json({ error: 'Missing Stripe signature.' }, { status: 400 });
  try {
    const event = stripeClient().webhooks.constructEvent(await request.text(), signature, webhookSecret);
    const result = await processStripeEvent(event);
    return Response.json({ received: true, result });
  } catch (error) {
    console.error('Stripe webhook rejected:', error instanceof Error ? error.message : 'unknown error');
    return Response.json({ error: 'Invalid Stripe webhook.' }, { status: 400 });
  }
}
