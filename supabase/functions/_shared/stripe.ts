import Stripe from 'npm:stripe@18'

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
