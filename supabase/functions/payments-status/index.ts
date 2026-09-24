// ============================================================================
// payments-status — is the platform able to take money, and if not, why
//
// §12 asks for operating instructions for the administrator, and QLT-02 asks
// that a problem be explained in ordinary language with somewhere to go. Until
// this existed neither was true of the one thing that stops every paid sale:
// an administrator had no way to learn whether Stripe was configured. The
// first sign of a missing key was an attendee meeting `stripe_not_configured`
// at checkout.
//
// BUY-13 is why there is no screen that *sets* a key. Amazing-hosted events
// take money into Amazing's own Stripe account, so there is one platform key
// and it lives in Supabase's secret store, encrypted at rest and injected into
// this runtime as an environment variable. It never goes near a browser.
//
// THE RULE THIS FILE EXISTS TO KEEP, and the one to re-read before editing it:
//
//   **No response from this function may contain key material.** Not the key,
//   not a prefix, not a suffix, not a masked form, not a length, not a hash.
//   A "last four characters" convenience is how a secret ends up in a browser
//   devtools tab, a screenshot, a support ticket and a log aggregator. What an
//   administrator actually needs is whether it is set, whether it works, and
//   what to run if not — and none of those require showing them the value.
//
// The one derived fact that IS returned is the mode, test or live, taken from
// whether the key begins `sk_test_` or `sk_live_`. That is not key material —
// it is a property of the account, visible on every Stripe page, and telling
// an administrator they are pointed at test mode when they think they are live
// is the single most useful thing on the screen.
// ============================================================================

import { stripeClient, stripeSetting } from '../_shared/stripe.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

/** The eight deliveries stripe-webhook acts on (PAYMENTS.md §2.5). */
const REQUIRED_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.payment_failed',
  'charge.refund.updated',
  'refund.updated',
  'account.updated',
]

interface SecretState {
  set: boolean
  /** Only ever 'test' | 'live' | null — never any part of the value. */
  mode?: 'test' | 'live' | null
}

function presence(value: string | undefined): SecretState {
  return { set: Boolean(value && value.trim()) }
}

/** test or live, from the documented key prefixes. Never the key itself. */
function modeOf(key: string | undefined): 'test' | 'live' | null {
  if (!key) return null
  if (key.startsWith('sk_test_')) return 'test'
  if (key.startsWith('sk_live_')) return 'live'
  return null
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return json(null, 204)
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!anonKey) return json({ error: 'SUPABASE_ANON_KEY is not set.' }, 500)

  // Administrators only, asked of the caller's own token. This reports the
  // health of the platform's money plumbing; it is not a member's business,
  // and a connector has their own page for their own account.
  const authorization = request.headers.get('Authorization') ?? ''
  if (!authorization) return json({ error: 'Sign in first.' }, 401)
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
  })
  const { data: isAdmin } = await asCaller.rpc('is_admin')
  if (!isAdmin) return json({ error: 'Not authorised.' }, 403)

  const secretKey = await stripeSetting('STRIPE_SECRET_KEY')
  const siteUrl = Deno.env.get('SITE_URL') ?? null

  const secrets = {
    STRIPE_SECRET_KEY: { ...presence(secretKey), mode: modeOf(secretKey) },
    STRIPE_WEBHOOK_SECRET: presence(await stripeSetting('STRIPE_WEBHOOK_SECRET')),
    STRIPE_CONNECT_CLIENT_ID: presence(await stripeSetting('STRIPE_CONNECT_CLIENT_ID')),
    STRIPE_CONNECT_STATE_SECRET: presence(Deno.env.get('STRIPE_CONNECT_STATE_SECRET')),
    // Not secrets. A URL and a number, both safe to show, and both worth
    // showing because a wrong SITE_URL breaks the OAuth return silently.
    SITE_URL: siteUrl,
    PLATFORM_FEE_BPS: Number(Deno.env.get('PLATFORM_FEE_BPS') ?? '0'),
  }

  // Set is not the same as working. A revoked, rotated or mistyped key is
  // "set" and still takes no money, so the only honest check is to use it.
  let account: {
    reachable: boolean
    id: string | null
    charges_enabled: boolean | null
    payouts_enabled: boolean | null
    error: string | null
  } = { reachable: false, id: null, charges_enabled: null, payouts_enabled: null, error: null }

  let webhook: {
    checked: boolean
    found: boolean
    status: string | null
    missing_events: string[]
    error: string | null
  } = { checked: false, found: false, status: null, missing_events: [], error: null }

  if (secretKey) {
    const stripe = stripeClient(secretKey)

    try {
      const me = await stripe.accounts.retrieve()
      account = {
        reachable: true,
        id: me.id,
        charges_enabled: Boolean(me.charges_enabled),
        payouts_enabled: Boolean(me.payouts_enabled),
        error: null,
      }
    } catch (error) {
      account.error = error instanceof Error ? error.message : String(error)
    }

    // Does an endpoint exist for us, and is it subscribed to everything
    // stripe-webhook acts on? A missing `account.updated` is the kind of gap
    // that costs nothing until a connector is restricted mid-sale.
    try {
      const endpoints = await stripe.webhookEndpoints.list({ limit: 100 })
      // Matched on the function path rather than the whole URL: the project
      // ref in front of it differs between environments, and an administrator
      // comparing two hostnames by eye is not a check.
      const ours = endpoints.data.find((e) => e.url.includes('/functions/v1/stripe-webhook'))
      webhook.checked = true
      if (ours) {
        webhook.found = true
        webhook.status = ours.status
        webhook.missing_events = REQUIRED_EVENTS.filter(
          (name) => !ours.enabled_events.includes(name) && !ours.enabled_events.includes('*'),
        )
      }
    } catch (error) {
      webhook.checked = true
      webhook.error = error instanceof Error ? error.message : String(error)
    }
  }

  return json(
    {
      secrets,
      account,
      webhook,
      // Stripe exposes `connect` only as a create parameter; the endpoint
      // object it returns says nothing about whether the endpoint listens to
      // connected accounts. So this cannot be verified here and the screen
      // says so rather than implying it checked. It matters more than its size
      // suggests: without it every connector's sale is delivered nowhere, the
      // buyer is charged, and the order sits pending until its hold lapses.
      connected_accounts_checkable: false,
    },
    200,
  )
})

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    },
  })
}
