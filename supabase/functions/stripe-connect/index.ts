// ============================================================================
// stripe-connect — a super connector attaches their own Stripe account
//
// CONTRACT §7.1. A super connector's events pay the connector, on the
// connector's own Stripe account, and we make that true by holding an account
// id and nothing else. `connectors.stripe_account_id` (`acct_…`) is the whole
// of what we store. We never hold anybody's secret key, never ask for one, and
// never give a connector a webhook of their own to configure — charges are
// made on their account with *our* platform key and the `stripeAccount`
// request option, and their events come back to our single endpoint tagged
// with `event.account`.
//
// Four actions, one function, because they are four steps of one conversation:
//
//   start       hand back the Stripe OAuth URL to send the connector to
//   callback    exchange the code Stripe sent them back with, store the id
//   refresh     re-read the account and update what Stripe will let them do
//   disconnect  deauthorise, and stop new paid sales — nothing else
//
// Who may act on what (BUY-14, ORG-01C):
//
//   A connector may only ever act on their own connector row. The row is found
//   from `connectors.profile_id`, never from a connector id the caller sent —
//   a caller cannot name someone else's row because their id is not read from
//   the request at all. An admin may name a row, and says which one.
//
//   But naming a row and *connecting an account to it* are different powers,
//   and only two of the four actions are open to an admin acting for somebody
//   else:
//
//     start       owner only. Connecting Stripe is consent by the account's
//     callback    owner, and cannot be given on their behalf — see mustOwn.
//     refresh     admin too. Re-reads Stripe; cannot introduce an account.
//     disconnect  admin too. A support power you want when a connector goes
//                 dark, and it can only ever take capability away.
//
//   The asymmetry is deliberate and is asserted in
//   scripts/check-connect-state.ts, because three actions accepting a
//   connector id and one refusing it looks like an oversight to anybody who
//   meets it cold.
//
//   `can_create_events` is required to start. A connector who cannot put
//   events on the calendar has no revenue to route, and connecting Stripe
//   would be an invitation to sell tickets they cannot create (ORG-01A).
//
// Why the `state` is signed (§7.3):
//
//   The callback is a URL Stripe hands to a browser, so it is the one part of
//   this flow an attacker gets to touch. Two things must be impossible: aiming
//   a successful connection at a connector row that is not yours, and replaying
//   somebody else's callback.
//
//     aiming      the connector id is inside the signed state, so changing it
//                 breaks the HMAC and the callback is refused before Stripe is
//                 called. The signing key never leaves the edge runtime.
//
//     replay      the state is bound to the profile it was issued to and
//                 expires in ten minutes, so a stolen state is useless without
//                 that person's session. Behind that, an OAuth code is
//                 single-use *at Stripe* — a replayed callback that somehow
//                 passed both checks still fails at `oauth.token`, because
//                 Stripe has already spent the code. Three things have to fail
//                 for a replay to land.
//
// ponytail: the signature is HMAC-SHA256 with the service-role key, which is
// already the most privileged secret this runtime holds and already never
// leaves it. A dedicated STRIPE_CONNECT_STATE_SECRET overrides it if the two
// ever need separate rotation schedules.
//
// Disconnecting is deliberately small (§7.3, last row). It sets a status and
// nothing else. Orders, tickets, registrations and refunds are not read here
// and not written here, because somebody who bought a ticket last week must
// keep their ticket, their check-in and their right to a refund when the
// organiser walks away from Stripe today.
//
// Deploy:  supabase functions deploy stripe-connect
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_...
//          supabase secrets set STRIPE_CONNECT_CLIENT_ID=ca_...
//          supabase secrets set SITE_URL=https://goamazing.ai            (optional)
//          supabase secrets set STRIPE_CONNECT_STATE_SECRET=...          (optional)
// See docs/event-platform/PAYMENTS.md for where each of those comes from.
// ============================================================================

import Stripe from 'npm:stripe@18'
import { stripeClient } from '../_shared/stripe.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'
import { signState, STATE_MINUTES, verifyState } from './state.ts'

/**
 * The service-role client's type, taken from an actual call rather than from
 * `ReturnType<typeof createClient>`. With no generated `Database` type,
 * `createClient`'s schema generics fall back to their *constraints* when read
 * off the bare signature, which resolves to `never` and makes every real
 * client unassignable to it. Inferring from a call that looks like the calls we
 * make gets the type we actually hold. `invite-email` and `waitlist-email`
 * dodge this by having no helper that takes a client; these functions do.
 */
const clientOfOurs = (url: string, key: string) => createClient(url, key)
type Db = ReturnType<typeof clientOfOurs>

const SITE = (Deno.env.get('SITE_URL') ?? 'https://goamazing.ai').replace(/\/+$/, '')

/**
 * Registered in the Stripe dashboard, character for character. Stripe refuses
 * the exchange if what we send here is not on its list, so this string and the
 * one in PAYMENTS.md have to stay the same string.
 */
const REDIRECT_URI = `${SITE}/connector/stripe/return`

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return json(null, 204)
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  const clientId = Deno.env.get('STRIPE_CONNECT_CLIENT_ID')
  if (!stripeKey || !clientId) {
    // Named precisely, because the person who can fix this is reading the log.
    return json(
      {
        error:
          'Stripe Connect is not configured on this project. Set STRIPE_SECRET_KEY and ' +
          'STRIPE_CONNECT_CLIENT_ID (supabase secrets set ...) and deploy again. ' +
          'Free events are unaffected — they need no Stripe configuration at all.',
        reason: 'stripe_not_configured',
      },
      500,
    )
  }

  const authorization = request.headers.get('Authorization') ?? ''
  if (!authorization) return json({ error: 'Sign in first.' }, 401)

  let action = ''
  let connectorId = ''
  let code = ''
  let state = ''
  try {
    const body = await request.json()
    action = String(body?.action ?? '').trim()
    connectorId = String(body?.connector_id ?? '').trim()
    code = String(body?.code ?? '').trim()
    state = String(body?.state ?? '').trim()
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400)
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!anonKey) return json({ error: 'SUPABASE_ANON_KEY is not set.' }, 500)

  // The caller's token answers "who is asking". The service role does the
  // privileged reading and writing, and is never handed the caller's question.
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
  })
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: userData } = await asCaller.auth.getUser()
  const me = userData?.user?.id
  if (!me) return json({ error: 'Sign in first.' }, 401)

  const { data: isAdmin } = await asCaller.rpc('is_admin')

  // See state.ts for why this is the key. Never sent anywhere, only used to
  // sign and verify the state that travels through the connector's browser.
  const stateSecret =
    Deno.env.get('STRIPE_CONNECT_STATE_SECRET') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const stripe = stripeClient(stripeKey)

  try {
    switch (action) {
      case 'start':
        return await onStart(db, { me, isAdmin: !!isAdmin, connectorId, clientId, stateSecret })
      case 'callback':
        return await onCallback(db, stripe, { me, isAdmin: !!isAdmin, code, state, stateSecret })
      case 'refresh':
        return await onRefresh(db, stripe, { me, isAdmin: !!isAdmin, connectorId })
      case 'disconnect':
        return await onDisconnect(db, stripe, { me, isAdmin: !!isAdmin, connectorId, clientId })
      default:
        return json({ error: "action must be 'start', 'callback', 'refresh' or 'disconnect'." }, 400)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`stripe-connect ${action}: ${message}`)
    return json({ error: message }, 502)
  }
})

/* -------------------------------------------------------------------------- */
/* start                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * §7.1, BUY-14. Connecting a Stripe account is an act of **consent by its
 * owner**, and there is no version of doing it on somebody's behalf that is
 * correct.
 *
 * The bug this exists to prevent, because it fails silently and plausibly: an
 * admin reaches `start` for a connector, so the state is signed with the
 * admin's `profile_id`; the admin then signs in at Stripe's page with an
 * account they control; `oauth.token` returns **their** `acct_…`; and we write
 * it onto the connector's row. The connector's payment setup then reads
 * `ready`, sales open, every screen says the money is theirs, and it lands in
 * Amazing's account instead. Nobody finds out until a connector asks where
 * their revenue went — which is exactly BUY-14's "do not route revenue to
 * another host's account".
 *
 * So the rule is ownership, not administration: you may only connect an account
 * to your own connector row. An admin who is also a connector passes, for their
 * own row, like anybody else.
 *
 * `refresh` and `disconnect` deliberately do **not** call this. Both are safe
 * — neither can introduce an account — and both are support powers an admin
 * genuinely needs, `disconnect` most of all when a connector goes dark.
 * ponytail: the asymmetry is the point. Do not "tidy" it by making all four
 * consistent; scripts/check-connect-state.ts asserts it stays this way.
 */
function mustOwn(row: ConnectorRow, me: string): Response | null {
  if (row.profile_id === me) return null
  return json(
    {
      error:
        'A Stripe account can only be connected by the person who owns the connector. ' +
        'Ask them to run Connect Stripe from their own connector page — it cannot be ' +
        'done on their behalf, because it is their account that must be authorised.',
      reason: 'consent_required',
    },
    403,
  )
}

async function onStart(
  db: Db,
  ctx: {
    me: string
    isAdmin: boolean
    connectorId: string
    clientId: string
    stateSecret: string
  },
): Promise<Response> {
  const connector = await connectorFor(db, ctx)
  if ('error' in connector) return connector.error

  // Consent before anything else — see mustOwn.
  const notMine = mustOwn(connector.row, ctx.me)
  if (notMine) return notMine

  // ORG-01A. Hosting permission first. Connecting Stripe to a connector who
  // cannot create events would set up revenue routing for sales that can
  // never happen, and would read on screen as permission they do not have.
  if (!connector.row.can_create_events) {
    return json(
      {
        error:
          'This connector cannot create events yet, so there is nothing for a Stripe ' +
          'account to be paid for. An administrator turns event creation on first.',
        reason: 'cannot_create_events',
      },
      403,
    )
  }

  const state = await signState(
    { connector_id: connector.row.id, profile_id: ctx.me },
    ctx.stateSecret,
  )

  // Standard accounts, read_write. Standard is what makes the connector Stripe's
  // customer rather than ours: they hold the account, they see their own
  // dashboard, they pay Stripe's fees, they own their disputes (§7.1).
  const authorize = new URL('https://connect.stripe.com/oauth/authorize')
  authorize.searchParams.set('client_id', ctx.clientId)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', 'read_write')
  authorize.searchParams.set('redirect_uri', REDIRECT_URI)
  authorize.searchParams.set('state', state)
  // Stripe prefills its own signup form with this. Nothing here is a promise —
  // the connector edits every field on Stripe's page.
  authorize.searchParams.set('stripe_user[business_type]', 'company')

  return json({
    url: authorize.toString(),
    state,
    connector_id: connector.row.id,
    redirect_uri: REDIRECT_URI,
    expires_at: new Date(Date.now() + STATE_MINUTES * 60_000).toISOString(),
  })
}

/* -------------------------------------------------------------------------- */
/* callback                                                                    */
/* -------------------------------------------------------------------------- */

async function onCallback(
  db: Db,
  stripe: Stripe,
  ctx: { me: string; isAdmin: boolean; code: string; state: string; stateSecret: string },
): Promise<Response> {
  if (!ctx.code) return json({ error: 'Stripe sent no code back.' }, 400)

  const claim = await verifyState(ctx.state, ctx.stateSecret)
  if (!claim) {
    return json(
      {
        error:
          'That Stripe connection link has expired or does not belong to this session. ' +
          'Start connecting again from the connector page.',
        reason: 'bad_state',
      },
      400,
    )
  }
  // The state was issued to one person. An admin acting for a connector gets
  // their own state, so this holds for them too — nobody finishes a connection
  // somebody else started.
  if (claim.profile_id !== ctx.me) {
    return json({ error: 'That Stripe connection was started by somebody else.' }, 403)
  }

  const connector = await connectorFor(db, {
    me: ctx.me,
    isAdmin: ctx.isAdmin,
    connectorId: claim.connector_id,
  })
  if ('error' in connector) return connector.error

  // Checked again here, at the point the account id is actually written. Only
  // `start` mints a state, so blocking it there already closes this path — but
  // the write is where the damage lands, and a guard on the door is worth less
  // than a guard on the safe.
  const notMine = mustOwn(connector.row, ctx.me)
  if (notMine) return notMine

  // The exchange. Stripe spends the code here, which is what makes a replayed
  // callback fail even if the state check somehow passed.
  const token = await stripe.oauth.token({ grant_type: 'authorization_code', code: ctx.code })
  const accountId = token.stripe_user_id
  if (!accountId) return json({ error: 'Stripe returned no account id.' }, 502)

  const flags = await readAccount(stripe, accountId)
  await db
    .from('connectors')
    .update({
      stripe_account_id: accountId,
      stripe_connected_at: new Date().toISOString(),
      ...flags,
    })
    .eq('id', connector.row.id)

  return json({ connector_id: connector.row.id, stripe_account_id: accountId, ...flags })
}

/* -------------------------------------------------------------------------- */
/* refresh                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * §7.3. What Stripe will let this account do changes without telling us — a
 * document goes out of date, a verification comes through. The *Connect Stripe*
 * screen calls this when it opens so what it shows is what Stripe thinks today,
 * and stripe-webhook calls the same reader on `account.updated` so the change
 * lands even when nobody is looking at the screen.
 */
async function onRefresh(
  db: Db,
  stripe: Stripe,
  ctx: { me: string; isAdmin: boolean; connectorId: string },
): Promise<Response> {
  const connector = await connectorFor(db, ctx)
  if ('error' in connector) return connector.error

  const accountId = connector.row.stripe_account_id
  if (!accountId) {
    return json({
      connector_id: connector.row.id,
      stripe_account_id: null,
      stripe_account_status: 'none',
      stripe_charges_enabled: false,
      stripe_payouts_enabled: false,
    })
  }

  const flags = await readAccount(stripe, accountId)
  await db.from('connectors').update(flags).eq('id', connector.row.id)
  return json({ connector_id: connector.row.id, stripe_account_id: accountId, ...flags })
}

/* -------------------------------------------------------------------------- */
/* disconnect                                                                  */
/* -------------------------------------------------------------------------- */

async function onDisconnect(
  db: Db,
  stripe: Stripe,
  ctx: { me: string; isAdmin: boolean; connectorId: string; clientId: string },
): Promise<Response> {
  const connector = await connectorFor(db, ctx)
  if ('error' in connector) return connector.error

  const accountId = connector.row.stripe_account_id
  if (accountId) {
    try {
      await stripe.oauth.deauthorize({ client_id: ctx.clientId, stripe_user_id: accountId })
    } catch (error) {
      // Already deauthorised on Stripe's side — from their dashboard, say. Our
      // row is the thing that is out of date, so carry on and correct it.
      const message = error instanceof Error ? error.message : String(error)
      console.error(`stripe-connect disconnect ${accountId}: ${message}`)
    }
  }

  // §7.3, last row, and the whole reason this function is four lines long.
  //
  // `stripe_account_id` is kept, not cleared. It is the only readable trace of
  // which account this connector used, and clearing it would make an
  // already-sold order's frozen `stripe_account_id` look like an orphan. New
  // paid sales stop because stripe-checkout reads `stripe_charges_enabled`.
  // Orders, tickets, registrations and refunds are not touched: refunds go
  // back through `event_orders.stripe_account_id` (§7.2), which this cannot
  // reach, so somebody who bought a ticket keeps everything they bought.
  await db
    .from('connectors')
    .update({
      stripe_account_status: 'disconnected',
      stripe_charges_enabled: false,
      stripe_payouts_enabled: false,
      stripe_checked_at: new Date().toISOString(),
    })
    .eq('id', connector.row.id)

  return json({
    connector_id: connector.row.id,
    stripe_account_id: accountId,
    stripe_account_status: 'disconnected',
    stripe_charges_enabled: false,
    stripe_payouts_enabled: false,
    // Said out loud so no screen has to guess, and so nobody adds a cascade here.
    existing_orders_unchanged: true,
  })
}

/* -------------------------------------------------------------------------- */
/* Who is allowed to touch which row                                           */
/* -------------------------------------------------------------------------- */

interface ConnectorRow {
  id: string
  profile_id: string
  can_create_events: boolean
  stripe_account_id: string | null
}

/**
 * The connector this call is about. A non-admin's row is found from their own
 * profile id and a `connector_id` in the body is ignored entirely — not
 * validated, not compared, never read. There is no path by which a connector
 * names a row that is not theirs, because the name is not an input.
 */
async function connectorFor(
  db: Db,
  ctx: { me: string; isAdmin: boolean; connectorId: string },
): Promise<{ row: ConnectorRow } | { error: Response }> {
  const columns = 'id, profile_id, can_create_events, stripe_account_id'

  if (ctx.isAdmin && ctx.connectorId) {
    const { data } = await db.from('connectors').select(columns).eq('id', ctx.connectorId).maybeSingle()
    if (!data) return { error: json({ error: 'That connector does not exist.' }, 404) }
    return { row: data as ConnectorRow }
  }

  const { data } = await db.from('connectors').select(columns).eq('profile_id', ctx.me).maybeSingle()
  if (!data) {
    return {
      error: json(
        { error: 'Only a connector can connect a Stripe account.', reason: 'not_a_connector' },
        403,
      ),
    }
  }
  return { row: data as ConnectorRow }
}

/* -------------------------------------------------------------------------- */
/* What Stripe says this account can do                                        */
/* -------------------------------------------------------------------------- */

interface Capability {
  stripe_charges_enabled: boolean
  stripe_payouts_enabled: boolean
  stripe_account_status: string
  stripe_checked_at: string
}

/**
 * §2's four columns, from one read. `charges_enabled` is the one that decides
 * whether paid tickets may go on sale — `ready` is a summary for a screen, and
 * no gate is ever written against the summary.
 */
async function readAccount(stripe: Stripe, accountId: string): Promise<Capability> {
  const account = await stripe.accounts.retrieve(accountId)
  const charges = !!account.charges_enabled
  const payouts = !!account.payouts_enabled
  // `disabled_reason` is Stripe saying it has stopped this account, as opposed
  // to not having finished with it yet. The two need different words on screen.
  const restricted = !!account.requirements?.disabled_reason
  return {
    stripe_charges_enabled: charges,
    stripe_payouts_enabled: payouts,
    stripe_account_status: restricted ? 'restricted' : charges && payouts ? 'ready' : 'pending',
    stripe_checked_at: new Date().toISOString(),
  }
}

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
