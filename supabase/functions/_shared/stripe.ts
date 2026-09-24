import Stripe from 'npm:stripe@18'
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

/**
 * The one place a Stripe client is built.
 *
 * STRIPE_API_BASE is for local runs only: it points the SDK at the fake Stripe
 * in scripts/stripe-sim (e.g. http://host.docker.internal:12111). Production
 * never sets it, and unset this is exactly
 * `new Stripe(key, { httpClient: Stripe.createFetchHttpClient() })` — every
 * request goes to Stripe as before.
 *
 * When it is set, every request is rewritten to that origin, not only those on
 * the default api host: stripe.oauth.* names connect.stripe.com per call, and
 * host/port/protocol alone would still send it there. Nothing may leave for a
 * real Stripe host from a simulated run.
 */
export function stripeClient(key: string): Stripe {
  const base = Deno.env.get('STRIPE_API_BASE')
  if (!base) return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() })
  const url = new URL(base)
  const toSim: typeof fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input))
    target.protocol = url.protocol
    target.host = url.host
    return fetch(target, init)
  }
  return new Stripe(key, {
    httpClient: Stripe.createFetchHttpClient(toSim),
    host: url.hostname,
    port: url.port || (url.protocol === 'https:' ? '443' : '80'),
    protocol: url.protocol.replace(':', '') as 'http' | 'https',
  })
}

type StripeSettingName = 'STRIPE_SECRET_KEY' | 'STRIPE_WEBHOOK_SECRET' | 'STRIPE_CONNECT_CLIENT_ID'

// ponytail: one read a minute per isolate, so a key changed on the Payments
// page takes up to a minute to reach a warm function. Drop the cache if that
// ever matters more than a database call on every webhook delivery.
let saved: { at: number; values: Record<string, string> } | null = null

/**
 * A Stripe setting: the value an administrator saved on the admin Payments
 * page (Supabase Vault, read through the service-role-only stripe_secrets()),
 * else this function's environment secret, which is how it was set before
 * that page could. A failed read falls back to the environment rather than
 * failing the request, and says so in the log.
 */
export async function stripeSetting(name: StripeSettingName): Promise<string | undefined> {
  if (!saved || Date.now() - saved.at > 60_000) {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data, error } = await db.rpc('stripe_secrets')
    if (error) console.error(`stripeSetting: could not read saved Stripe keys, using the environment: ${error.message}`)
    saved = {
      at: Date.now(),
      values: Object.fromEntries(
        ((data ?? []) as { name: string; value: string | null }[])
          .filter((r) => r.value)
          .map((r) => [r.name, r.value as string]),
      ),
    }
  }
  return saved.values[name] || Deno.env.get(name) || undefined
}
