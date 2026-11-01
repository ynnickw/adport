import { processStripeEvent, stripeClient } from '@/lib/cloud/billing';
import { env } from '@/lib/env';
import type Stripe from 'stripe';

export const maxDuration = 60;

export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');
  const webhookSecret = env().STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) return Response.json({ error: 'Missing Stripe signature.' }, { status: 400 });
  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(await request.text(), signature, webhookSecret);
  } catch {
    return Response.json({ error: 'Invalid Stripe signature.' }, { status: 400 });
  }
  try {
    const result = await processStripeEvent(event);
    return Response.json({ received: true, result });
  } catch (error) {
    console.error('Stripe webhook processing failed:', event.id, error instanceof Error ? error.message : 'unknown error');
    return Response.json({ error: 'Stripe webhook processing failed. Please retry.' }, { status: 500 });
  }
}
