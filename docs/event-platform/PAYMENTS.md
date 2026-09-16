# Payments — Stripe Connect setup, deploy and verification

Everything needed to turn card payments on, and an honest list of what nobody
has been able to check yet. Companion to `CONTRACT.md` §7 — that says what the
rules are, this says how to make them real.

**Nothing here has been run.** The project has no Stripe keys. Every command
below is written to be executed once they exist, and §8 says exactly which
behaviours are still unproven until somebody does.

---

## 1. The model in one paragraph

Whoever **created** the event owns its money. An admin-created event pays
Amazing's own Stripe account. A super-connector-created event pays that
connector, on **their own** Stripe account, connected by OAuth. We store
`connectors.stripe_account_id` (`acct_…`) and **never anybody's secret key**.
Charges are **direct charges** — created on the connected account by passing
`stripeAccount: acct_…` as a request option with our platform key — so funds
land in the connector's balance, they pay Stripe's fees, and they own refunds
and disputes. `application_fee_amount` is never set: §13 excludes platform
commission from this release.

One webhook endpoint serves every connector. No connector configures anything
in Stripe beyond their own account.

---

## 2. Stripe dashboard — the exact click-path

Do all of this **in test mode first** (the toggle is top right, "Test mode").
Test mode and live mode have separate keys, separate client ids, separate
webhook endpoints and separate redirect URIs. Everything below has to be done
twice, once per mode.

Menu names move between dashboard releases. Where a direct URL is given, the
URL is authoritative — go there if the menu path does not match what you see.

### 2.1 Enable Connect with Standard accounts

1. Sign in as an **administrator** of the Amazing Stripe account.
2. Go to **Connect** in the left sidebar → **Get started**.
   Direct: <https://dashboard.stripe.com/connect/overview>
3. Stripe asks what the platform does. Choose **Platform or marketplace**, and
   when asked who the customer pays, choose that sellers (our connectors)
   collect payments themselves.
4. **Settings → Connect settings**, direct:
   <https://dashboard.stripe.com/settings/connect>
5. Under **Account types** / **Onboarding options**, enable **Standard**.
   Standard is the one this build needs, and the reason is not cosmetic:
   a Standard account is Stripe's customer, not ours. They hold the account,
   they get their own Stripe dashboard, **they pay Stripe's fees**, and they
   own their own disputes. Express or Custom would put all three back on
   Amazing, which is the opposite of what BUY-14 asks for.
6. Fill in the **public platform profile** on the same page — business name,
   support email, icon, colour. This is what a connector sees on the Stripe
   OAuth consent screen, so it should say Amazing and not a placeholder.

### 2.2 Register the OAuth redirect URI

Still on <https://dashboard.stripe.com/settings/connect>, find the
**OAuth settings** section (older dashboards: **Integration**).

1. Under **Redirects**, click **Add URI**.
2. Enter, character for character:

   ```
   https://goamazing.ai/connector/stripe/return
   ```

3. Save. Add a second URI for local development if you will run the flow
   locally: `http://localhost:5173/connector/stripe/return`.

Stripe compares `redirect_uri` against this list on a **string** match. A
trailing slash, `http` instead of `https`, or `www.` makes the exchange fail
with `invalid_redirect_uri`. The same string is built in
`supabase/functions/stripe-connect/index.ts` as `${SITE_URL}/connector/stripe/return`
— if you change one, change the other.

### 2.3 Find the Connect client id

Same page, **OAuth settings** section. There is a field labelled
**Client ID** holding a value beginning `ca_`.

- Test mode and live mode show **different** `ca_…` values. Copy the one for
  the mode you are configuring.
- This is the value for `STRIPE_CONNECT_CLIENT_ID`.
- It is not secret in the way a key is — it appears in the OAuth URL a
  connector's browser visits — but it is still set as a Supabase secret so
  there is one place to change it.

### 2.4 Get the platform secret key

**Developers → API keys**, direct: <https://dashboard.stripe.com/apikeys>

- **Secret key** (`sk_test_…` / `sk_live_…`) → `STRIPE_SECRET_KEY`.
- This is Amazing's platform key. It is the *only* Stripe secret key this
  system ever holds. A connector is never asked for theirs and there is no
  field anywhere to put one in.

### 2.5 Create the webhook endpoint

**Developers → Webhooks → Add endpoint**, direct:
<https://dashboard.stripe.com/webhooks>

1. **Endpoint URL** — your project's function URL:

   ```
   https://<project-ref>.supabase.co/functions/v1/stripe-webhook
   ```

   `<project-ref>` is the subdomain of the project's Supabase URL.

2. **Select events** — subscribe to exactly these eight:

   | Event | What it does here |
   | --- | --- |
   | `checkout.session.completed` | order `paid`, place `confirmed`, ticket issued, confirmation queued |
   | `checkout.session.async_payment_succeeded` | the same, for a payment method that clears after the session closes |
   | `checkout.session.async_payment_failed` | order `failed`, place released |
   | `checkout.session.expired` | order `failed`, place released back into the pool |
   | `payment_intent.payment_failed` | order `failed`, place released |
   | `charge.refund.updated` | `event_refunds.status` follows Stripe |
   | `refund.updated` | same, the newer name for it |
   | `account.updated` | connector capability flags refreshed (§7.3) |

   The two `async_payment_*` rows matter only if a delayed payment method
   (Bacs Direct Debit, Klarna, bank transfer) is ever enabled in the Stripe
   dashboard. Subscribe to them anyway: enabling such a method is a dashboard
   tick, not a deploy, and without these two the orders it creates would
   complete their session and then never confirm.

3. **Turn on "Listen to events on connected accounts".**

   This is the checkbox the whole design depends on and it is easy to miss.
   Without it, Stripe delivers only events that happened on Amazing's own
   account. **Every super connector's sale would silently never arrive** — the
   attendee would pay, the money would land in the connector's balance, and
   the order would sit at `pending` until its hold lapsed and the place went
   back on sale. No error anywhere. If connector sales appear to pay but never
   confirm, this checkbox is the first thing to check.

   Deliveries from a connected account carry `event.account = acct_…`, which
   `stripe-webhook` reads to decide whose sale it is, and uses to make sure a
   session id from one account can never move an order taken on another.

4. Save, then copy the **Signing secret** (`whsec_…`) →
   `STRIPE_WEBHOOK_SECRET`. It is shown once on creation and afterwards behind
   **Reveal**.

---

## 3. Secrets

| Secret | Where it comes from | Used by | Required |
| --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | §2.4, `sk_…` | all five functions | for paid events |
| `STRIPE_WEBHOOK_SECRET` | §2.5, `whsec_…` | `stripe-webhook` | for paid events |
| `STRIPE_CONNECT_CLIENT_ID` | §2.3, `ca_…` | `stripe-connect` | for connector events |
| `SITE_URL` | your own domain | `stripe-connect`, `stripe-checkout` | optional, defaults `https://goamazing.ai` |
| `PLATFORM_FEE_BPS` | your own decision | `stripe-checkout` | optional, defaults `0` |
| `STRIPE_CONNECT_STATE_SECRET` | any long random string | `stripe-connect` | optional, defaults to the service-role key |

**Free events need none of these.** Every function returns a clear, named
`stripe_not_configured` 500 when a secret it needs is absent, and free
registration never touches any of them — it goes through the `register_free`
RPC, which has no Stripe dependency at all.

`PLATFORM_FEE_BPS` is a booking fee shown to the attendee on its own line
(EVT-04). It is **not** platform commission and **not** an application fee: on
a connector's direct charge it lands in the connector's balance with the rest
of the money. Leave it at 0, which is what §13 requires for this release.

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_test_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set STRIPE_CONNECT_CLIENT_ID=ca_...
supabase secrets set SITE_URL=https://goamazing.ai

# Optional
supabase secrets set PLATFORM_FEE_BPS=0
supabase secrets set STRIPE_CONNECT_STATE_SECRET="$(openssl rand -hex 32)"

# Confirm they landed (values are not shown, only names and digests)
supabase secrets list
```

## 4. Deploy

```bash
supabase functions deploy stripe-connect
supabase functions deploy stripe-checkout
supabase functions deploy event-refund

# The reconciliation sweep (§9). pg_cron calls it with the service-role key,
# which is a valid project JWT, so verify_jwt stays on and no flag is needed.
supabase functions deploy stripe-reconcile

# Stripe signs with its own stripe-signature header and carries no Supabase
# JWT, so JWT verification must be off or every delivery 401s. The signature
# check inside the function is what stands in for it.
supabase functions deploy stripe-webhook --no-verify-jwt
```

`supabase/config.toml` already carries `[functions.stripe-webhook] verify_jwt = false`,
so a deploy that reads the config gets the same setting without the flag. The
flag is in the command because a deploy run from elsewhere may not.

The other three **keep** JWT verification. They are called by our own signed-in
UI and the caller's token is what answers "who is asking" — including on the
OAuth callback, which is why a stolen `state` is useless without that person's
session.

---

## 5. Request and response shapes

All four take `POST` with `Content-Type: application/json` and an
`Authorization: Bearer <supabase access token>` header, except `stripe-webhook`,
which Stripe calls directly. All four answer errors as
`{ "error": "<sentence>", "reason": "<machine tag>" }`.

### 5.1 `stripe-connect`

```jsonc
// action: 'start'    — caller must be a connector with can_create_events,
//                      or an admin naming a connector_id
{ "action": "start", "connector_id": "<uuid, admins only>" }
→ 200 {
    "url": "https://connect.stripe.com/oauth/authorize?...",
    "state": "<signed, ten-minute>",
    "connector_id": "<uuid>",
    "redirect_uri": "https://goamazing.ai/connector/stripe/return",
    "expires_at": "<iso8601>"
  }
→ 403 { "error": "...", "reason": "cannot_create_events" | "not_a_connector" }
→ 403 { "error": "...", "reason": "consent_required" }   // not your connector row

// action: 'callback' — the return page posts back what Stripe put in its URL
{ "action": "callback", "code": "<from ?code=>", "state": "<from ?state=>" }
→ 200 {
    "connector_id": "<uuid>",
    "stripe_account_id": "acct_...",
    "stripe_charges_enabled": true,
    "stripe_payouts_enabled": true,
    "stripe_account_status": "ready" | "pending" | "restricted",
    "stripe_checked_at": "<iso8601>"
  }
→ 400 { "error": "...", "reason": "bad_state" }
→ 403 { "error": "That Stripe connection was started by somebody else." }

// action: 'refresh'  — call this when the Connect Stripe screen opens
{ "action": "refresh", "connector_id": "<uuid, admins only>" }
→ 200  same body as callback; status "none" and a null account id if never connected

// action: 'disconnect'
{ "action": "disconnect", "connector_id": "<uuid, admins only>" }
→ 200 {
    "connector_id": "<uuid>",
    "stripe_account_id": "acct_...",      // kept, not cleared — see §7.2
    "stripe_account_status": "disconnected",
    "stripe_charges_enabled": false,
    "stripe_payouts_enabled": false,
    "existing_orders_unchanged": true
  }
```

A non-admin's `connector_id` is **ignored**, not validated — the row is found
from the caller's own `profiles.id`. There is no path by which a connector
names a row that is not theirs, because the name is never an input.

**An admin may name a row, but may not connect an account to it.** `start` and
`callback` refuse with `consent_required` unless the caller owns the connector.
Connecting Stripe is consent by the account's owner and cannot be given on their
behalf: an admin who completed that flow would authenticate at Stripe with an
account *they* control, and we would write their `acct_…` onto the connector's
row — payment setup reading `ready`, sales opening, every screen saying the money
was the connector's, and it landing in Amazing's account instead. Nobody would
find out until a connector asked where their revenue went (BUY-14, "do not route
revenue to another host's account").

`refresh` and `disconnect` **stay** open to an admin. Neither can introduce an
account, both are real support powers, and `disconnect` is the one you want when
a connector goes dark. The asymmetry is deliberate and asserted in
`scripts/check-connect-state.ts`, because three actions accepting a
`connector_id` and one refusing it reads as an oversight to anybody meeting it
cold.

### 5.2 `stripe-checkout`

```jsonc
{ "event_id": "<uuid>",          // or "slug": "<event slug>"
  "ticket_type_id": "<uuid>" }

→ 200 {
    "url": "https://checkout.stripe.com/c/pay/...",   // send the browser here
    "session_id": "cs_...",
    "order_id": "<uuid>",
    "registration_id": "<uuid>",
    "hold_expires_at": "<iso8601, now + 20 min>",
    "amount_cents": 2500,        // the total that will leave the card
    "fee_cents": 0,              // included in amount_cents, shown separately
    "currency": "gbp",
    "order_status": "pending"    // always; this function cannot write "paid"
  }

→ 401 { "error": "Sign in to book a place." }
→ 403 { "error": "...", "reason": "no_account" }                       // BUY-01
→ 403 { "error": "...", "reason": "onboarding_incomplete" }             // BUY-01
→ 503 { "error": "...", "reason": "profile_unreadable" }
→ 409 { "error": "...", "reason": "payment_confirming",                // §9
        "session_id": "cs_...", "registration_id": "<uuid>" }
→ 404 { "error": "That event does not exist." }                        // also a draft
→ 409 { "error": "...", "reason": "sold_out" | "closed" | "cancelled" | "finished" }
→ 409 { "error": "...", "reason": "already_registered" | "already_paid" }
→ 409 { "error": "<the one attendee sentence>",                       // §7.3
        "reason": "connector_stripe_missing"
                | "connector_charges_disabled"
                | "not_ready_for_paid_sales"
                | "connector_account_unresolved" }
→ 400 { "error": "...", "reason": "free_ticket" }                      // use register_free
→ 500 { "error": "...", "reason": "stripe_not_configured" }
```

`onboarding_incomplete` comes from the `onboarding_complete()` RPC — asked,
not reimplemented. That function is this codebase's one definition of BUY-01's
"required onboarding" (a profession, or being an admin, and not suspended or
removed), and it is what the RLS policy and `register_free()` already use. The
edge function asking the same question is what keeps free and paid registration
from drifting apart.

**The network questionnaire is deliberately not part of it.** An event-only
account never answers it (ACC-02), and a network member who has not answered it
is still entitled to buy a ticket. An earlier revision of this function added
that condition and produced a dead end: such a person could RSVP to a free event
but was refused at the Pay button, by a rule no other layer applied and no
screen could route them out of (QLT-02). `scripts/check-connect-state.ts`
asserts the gate stays exactly `onboarding_complete()` and nothing more.

Calling it twice — a refresh, a retry, a double click — returns the **same**
session. The `idempotency_key` is derived from the event, the person, the
ticket type and the live registration id, is unique in Postgres, and is handed
to Stripe, so the second create replays the first rather than opening another.

### 5.3 `event-refund`

```jsonc
{ "order_id": "<uuid>",
  "amount_cents": 2500,          // optional; omit to refund everything left
  "reason": "<free text>" }      // optional

→ 200 {
    "refund_id": "<uuid>",
    "status": "processing",      // never "completed" — only the webhook writes that
    "stripe_refund_id": "re_...",
    "amount_cents": 2500,
    "currency": "gbp",
    "remaining_cents": 0,
    "registration_unchanged": true   // BUY-08: refunding is not cancelling
  }

→ 403 { "error": "That is not yours to refund." }
→ 503 { "error": "...", "reason": "order_unreadable" }   // read failed; nothing was attempted
→ 409 { "error": "That refund is already in hand.",
        "reason": "refund_in_progress", "refund_id": "...", "status": "..." }   // BUY-09
→ 409 { "error": "There is no payment on this order to refund — it is pending." }
→ 400 { "error": "That is more than is left on this order — 1500 minor units remain." }
→ 502 { "error": "Stripe would not take the refund: ...",
        "reason": "needs_attention", "refund_id": "...", "status": "needs_attention" }
```

The refund goes back through `event_orders.stripe_account_id` — the account
that actually took the money — never through whatever the event says today.
That is what keeps refunds working after a connector is restricted or
disconnects (§7.2).

### 5.4 `stripe-webhook`

Called by Stripe, never by us. `200 {"received": true}` for everything it
accepts, including events it deliberately ignores. `400` for a bad or missing
signature (Stripe stops resending). `500` for a write that genuinely failed
(Stripe redelivers, and every handler is safe to run twice).

---

## 6. Local verification with the Stripe CLI

Install: <https://docs.stripe.com/stripe-cli>. Then `stripe login`.

### 6.1 Forward deliveries to a local function

```bash
supabase functions serve stripe-webhook --no-verify-jwt

# Platform-account events
stripe listen --forward-to http://127.0.0.1:54321/functions/v1/stripe-webhook

# Connected-account events — the local equivalent of §2.5 step 3.
# Without this flag no connector sale reaches the local function either.
stripe listen \
  --forward-to         http://127.0.0.1:54321/functions/v1/stripe-webhook \
  --forward-connect-to http://127.0.0.1:54321/functions/v1/stripe-webhook
```

`stripe listen` prints its own `whsec_…` on start. That is a **different**
secret from the dashboard endpoint's. Set it locally before the function will
verify anything:

```bash
echo 'STRIPE_WEBHOOK_SECRET=whsec_from_stripe_listen' >> supabase/functions/.env
echo 'STRIPE_SECRET_KEY=sk_test_...' >> supabase/functions/.env
supabase functions serve stripe-webhook --no-verify-jwt --env-file supabase/functions/.env
```

### 6.2 What `stripe trigger` can and cannot prove

Read this before trusting a green run.

`stripe trigger` builds its **own** Checkout session with its own fixture data.
It has no `client_reference_id` pointing at one of our orders and no
`metadata.order_id`, so `findOrder` will not match it and the handler will log
`no order for session cs_…` and stop. **That is the correct behaviour and it
is also the limit of the test.** What a trigger proves:

- the endpoint is reachable and `--no-verify-jwt` is right
- `constructEventAsync` verifies a real Stripe signature in Deno
- `event.account` routing picks the right branch
- an unknown session is acknowledged, not crashed on and not retried forever

What it does **not** prove: any of our order, registration, ticket or message
writes. Those need a session our own `stripe-checkout` created, which needs a
real test-mode key and a seeded event. Do that part with §6.4.

### 6.3 Trigger recipe

```bash
# --- successful purchase (platform account) ---------------------------------
stripe trigger checkout.session.completed
# expect: 200, and for a fixture session, "no order for session" in the log

# --- refresh after pay -------------------------------------------------------
# Re-deliver the same event. This is the replay test: the second delivery must
# change nothing. Copy an event id out of `stripe listen` output first.
stripe events resend evt_1234567890
# expect: 200, exactly one ticket, exactly one queued message, order still
#         `paid` with its original paid_at

# --- expired session ---------------------------------------------------------
stripe trigger checkout.session.expired
# expect: order -> failed, registration -> expired, the place back on sale

# --- declined card -----------------------------------------------------------
stripe trigger payment_intent.payment_failed
# expect: exactly the same two writes. A failed payment must never read as a
#         completed purchase (BUY-03).

# --- refund ------------------------------------------------------------------
stripe trigger charge.refund.updated
stripe trigger refund.updated
# expect: event_refunds.status follows Stripe. `completed` only for `succeeded`.

# --- duplicate refund attempt ------------------------------------------------
# Not a trigger — call the function twice against one paid order:
curl -sS -X POST "$SUPABASE_URL/functions/v1/event-refund" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: application/json' \
  -d '{"order_id":"<uuid>"}'
curl -sS -X POST "$SUPABASE_URL/functions/v1/event-refund" \
  -H "Authorization: Bearer $HOST_TOKEN" -H 'content-type: application/json' \
  -d '{"order_id":"<uuid>"}'
# expect: first 200 with status "processing"; second 409
#         {"reason":"refund_in_progress"} and **one** refund in the Stripe
#         dashboard, not two.

# --- the last ticket, twice --------------------------------------------------
# Not a trigger. Two checkout calls for the same event from two different
# accounts, at the same moment, with one place left:
curl -sS -X POST "$SUPABASE_URL/functions/v1/stripe-checkout" -H "Authorization: Bearer $A"   -H 'content-type: application/json' -d '{"slug":"<slug>","ticket_type_id":"<uuid>"}' &
curl -sS -X POST "$SUPABASE_URL/functions/v1/stripe-checkout" -H "Authorization: Bearer $B"   -H 'content-type: application/json' -d '{"slug":"<slug>","ticket_type_id":"<uuid>"}' &
wait
# expect: one 200 with a session url; one 409 {"reason":"sold_out"}. Check the
#         Stripe dashboard afterwards: there must be exactly ONE session, not
#         two, and no charge against the loser.

# --- connected-account sale --------------------------------------------------
stripe trigger checkout.session.completed --stripe-account acct_1234567890
# expect: the delivery arrives with event.account set, and the log shows the
#         connected branch. Needs --forward-connect-to from §6.1.

# --- delayed payment method, if one is ever enabled --------------------------
stripe trigger checkout.session.async_payment_succeeded
stripe trigger checkout.session.async_payment_failed
# expect: succeeded behaves exactly like a completed card session; failed
#         releases the place. Only reachable if Bacs/Klarna/bank transfer is
#         switched on in the Stripe dashboard.

# --- account.updated restriction ---------------------------------------------
stripe trigger account.updated --stripe-account acct_1234567890
# expect: that connector's stripe_charges_enabled / stripe_payouts_enabled /
#         stripe_account_status / stripe_checked_at updated to match.
#
# The fixture may report the account as healthy. To see a genuine restriction,
# use a test account Stripe has restricted on purpose — Connect test accounts
# can be pushed into `restricted` from the connected account's own dashboard by
# leaving required information out — then confirm the next stripe-checkout call
# for that connector's event returns `connector_charges_disabled` and **no**
# charge is created.
```

### 6.4 The end-to-end run, once keys exist

The only way to prove the writes. In test mode, with a test-mode super
connector who has connected a test Stripe account:

1. Create a paid event as that connector, publish it.
2. As an attendee, call `stripe-checkout`. Confirm an `event_registrations`
   row appears `pending` with `hold_expires_at` 20 minutes out, and an
   `event_orders` row `pending` with `stripe_account_id` = that connector's
   `acct_…` and `application_fee_cents` = 0.
3. Call `stripe-checkout` again before paying. Confirm the **same**
   `session_id` comes back and no second order row exists.
4. Pay with `4242 4242 4242 4242`. Confirm the order goes `paid`, the
   registration `confirmed`, exactly one `event_tickets` row, exactly one
   `event_messages` row.
5. Confirm in the **connector's** Stripe dashboard that the payment is on their
   account, that Stripe's fee came out of their balance, and that there is no
   application fee on it.
6. Refund it from `/manage/events/:id`. Confirm one `event_refunds` row, the
   refund visible on the connector's account, and that the attendee's
   registration is **still confirmed** (BUY-08).
7. Disconnect that connector's Stripe. Confirm new checkout on their event is
   refused with `connector_charges_disabled`, and that the refunded order, the
   ticket and check-in all still work.

---

## 7. Platform obligations that remain (BUY-15)

> *"The payment implementation must identify any platform obligations that
> remain under the selected integration."* — BUY-15

Stripe Connect with **Standard** accounts and **direct charges** moves a great
deal off Amazing. It does not move everything, and the difference is the point
of this section. Nothing below is legal advice; the commercial rows should be
confirmed with Stripe and with whoever signs Amazing's contracts before live
mode is switched on.

### 7.1 What genuinely moves to the connector

For an event a super connector created, on their own connected account:

- They are the **merchant of record** for that sale. The charge is created on
  their account and the funds land in their balance.
- **They pay Stripe's processing fees**, deducted from their balance.
- **They own disputes and chargebacks.** A disputed charge, and its fee, comes
  out of their balance, not Amazing's.
- **They own refunds**, funded from their balance.
- **Stripe onboards and verifies them directly.** They accept Stripe's own
  services agreement, hold their own Stripe dashboard, and Amazing never sees,
  handles or stores their identity documents or bank details.
- With Standard accounts specifically, a connected account's negative balance
  is Stripe's exposure to that account rather than the platform's — which is
  the main reason Standard was chosen over Express or Custom, where the
  platform carries that liability. **Confirm this against Amazing's own
  Connect platform agreement before relying on it.**

### 7.2 What stays Amazing's, whatever the integration

| Obligation | Why it does not move |
| --- | --- |
| **Every admin-created event, in full** | BUY-13. Those charge Amazing's own account. Amazing is merchant of record, pays the fees, funds the refunds, and eats the disputes. Connect changes nothing about them. |
| **The Connect relationship itself** | Amazing is the platform. Amazing signs Stripe's platform agreement, maintains the public platform profile a connector sees on the OAuth consent screen, and is accountable to Stripe for how the integration behaves. |
| **The integration's availability** | One webhook endpoint serves every connector. If it breaks, **every** connector's sales stop confirming at once — their customers pay and get no ticket. The money is theirs; the outage is ours. This is the largest operational obligation the design creates, and it is the price of not making each connector configure an endpoint of their own. |
| **The platform secret key** | `STRIPE_SECRET_KEY` can create charges on every connected account. It is the most dangerous secret in the system. Its custody, rotation and blast radius are entirely Amazing's. |
| **PCI scope** | Hosted Stripe Checkout keeps Amazing at SAQ A — no card data touches our servers. Staying there is an ongoing obligation, not a one-off: no card fields added to our own pages, no card data in logs or support tools. |
| **Telling people whose money it is** | BUY-14 requires the responsible payment account be clear *before* sales open. That disclosure is on Amazing's pages, so it is Amazing's duty regardless of whose balance the money reaches. |
| **The order and terms record** | BUY-15. `event_orders.terms_snapshot`, `event_orders.stripe_account_id` and `event_refunds` live in Amazing's database. Retention, accuracy and admin access to them are ours. QLT-08 says closing a host account must not erase them. |
| **Attendee personal data** | Amazing is the controller for attendee accounts, tickets, attendance and feedback. The connector's Stripe holds the payment records. Both exist; neither absolves the other. |
| **Being the place people complain to** | An attendee bought from Amazing's site. If a connector will not or cannot refund them, they will come to Amazing. Stripe may say the liability is the connector's; the attendee will not care. `event_refunds.status = 'needs_attention'` exists so an admin finds that case rather than discovering it by email. |
| **Deciding who may sell at all** | `can_create_events` is Amazing's switch. Turning it on for a connector who then mistreats customers is an Amazing decision with Amazing consequences. |

### 7.2a Where the paid-sale gate actually lives

Worth stating because it is the thing most likely to be "tidied" away.

There is no such thing as *you were allowed when you published*. A connector can
be restricted by Stripe, or disconnect, minutes after an event goes live, and a
paid ticket type can be added to an event that was free when it was published —
which no publish-time check ever re-runs. Stripe itself re-checks
`charges_enabled` on every charge for the same reason; so do Shopify and
Eventbrite, which block at sale rather than at publish.

So the checkout-time gate is **the** gate. The publish-time check is a courtesy
that fails early and kindly. All three consumers — checkout, publish and the
dashboard banner — now call one function, `event_sale_readiness(p_event)`,
returning `(can_sell_paid, reason, fix_action)`. There is one definition to
change and one to delete, and deleting it breaks all three loudly and together
rather than silently opening a hole at checkout months later.

`stripe-checkout` asks that function and does **not** read
`stripe_charges_enabled` itself. `scripts/check-connect-state.ts` asserts both,
negatively, so re-inlining the flag fails the check.

One thing it still resolves for itself: **which account takes the money**.
Readiness answers *may this event sell*; `events.payment_connector_id` answers
*whose money it is*. A connector event whose account cannot be resolved is
refused with `connector_account_unresolved` rather than falling through to a
null `stripeAccount`, which would mean Amazing's own balance — exactly BUY-14's
"do not route revenue to another host's account".

### 7.2b What the attendee is told, and what they are not

`event_sale_readiness()` returns `fix_action` — the organiser's instruction. It
names the host's Stripe account state and points at their payment settings.
`stripe-checkout` **does not pass it on**, and does not pass on the readiness
sentence either.

Everyone who calls `stripe-checkout` is an attendee. `fix_action` is a page they
cannot open and a fact about somebody else's Stripe account, and an error body is
somewhere information appears — QLT-05 applies there as much as to a screen or an
export. The organiser gets that sentence on their own dashboard and at publish,
from the same shared function.

So every paid-sale refusal returns **one** sentence, whatever the underlying
reason:

> This event cannot take payments at the moment, so tickets are not on sale. It
> is nothing you have done — the organiser has been told and needs to sort it out
> with their payment provider. Any booking you have already made is unaffected.

The differences between "not connected", "restricted by Stripe" and "account
could not be resolved" are real and they matter to the organiser, who has a
different job in each. To the attendee they are one fact with one next step, and
spelling them apart would only describe a stranger's Stripe account. `reason`
still carries the precise tag so a screen can branch on it — it is a tag, not a
sentence, and nothing renders it.

`scripts/check-connect-state.ts` asserts that `readiness.fix_action` is never
read, that every refusal uses the one sentence, and that the sentence itself
contains none of `stripe`, `acct_`, `connector`, `charges`, `restricted`,
`payout` or `dashboard`.

### 7.3 If a connector's account is disabled mid-sale

The case `CONTRACT.md` §7.3 calls the easy one to get wrong. Stripe can
restrict an account at any moment — a document expires, a verification lapses,
a review concludes — and it will do so mid-sale without warning. What happens,
step by step:

1. **Stripe sends `account.updated`.** `stripe-webhook` writes
   `stripe_charges_enabled = false` and `stripe_account_status = 'restricted'`
   onto that connector. Nothing else is touched.
2. **New paid sales stop.** The next `stripe-checkout` call for any event of
   theirs is refused with `connector_charges_disabled` **before Stripe is
   called**, so nobody is charged into an account that cannot settle. The
   message tells the organiser to finish what Stripe is asking for.
3. **Checkout sessions already open** are between the attendee and Stripe.
   Either the payment completes, in which case the webhook confirms the order
   and issues the ticket exactly as normal, or it fails, in which case the
   order goes `failed` and the place returns to the pool. There is no third
   outcome, and neither is a false success.
4. **Places held but unpaid** lapse with their 20-minute hold and go back on
   sale. Nobody is left holding a seat they cannot buy.
5. **Everything already paid is untouched.** Orders stay `paid`, tickets stay
   valid, check-in keeps working, `/events/mine` keeps showing them. This is
   BUY-14's "preserve access to existing bookings and payment support" and
   QLT-08's "must not silently erase outstanding bookings".
6. **Refunds are attempted against `event_orders.stripe_account_id`** — the
   account that actually took that money, frozen at checkout, never recomputed
   from the event. The refund is aimed correctly even though the connector is
   now restricted, or has disconnected entirely.
7. **A refund may still fail**, and this is the residual exposure worth stating
   plainly. Stripe can refuse a refund on a restricted account, and no refund
   can be funded from an empty balance. When that happens the `event_refunds`
   row is left `needs_attention` with Stripe's own message stored on it
   (QLT-09), the attendee is never told their money is back when it is not
   (BUY-08), and an admin resolves it out of band — by getting the connector to
   top their balance up, or by Amazing paying the attendee another way and
   recovering it commercially. **No code can fix this one**, because the money
   is in somebody else's account. The system's job is to make it visible and
   honest, and it does.
8. **The event itself is unaffected as an event.** It stays published, free
   tickets keep selling, and guests, emails, check-in and feedback all
   continue. Losing payment capability is not losing the event.

The same eight steps apply to a connector who disconnects deliberately, or
whose `can_create_events` is switched off, with one difference: those are
Amazing's or the connector's decision rather than Stripe's, so nothing arrives
by webhook and the state changes at the moment of the action instead.

---

## 8. Mapping to §11's acceptance examples

The rows in `REQUIREMENTS.md` §11 that land on payments, and where each is met.

| Example | Expected result | How |
| --- | --- | --- |
| New visitor comes from an event link | Registers and finds their ticket without joining a network | `stripe-checkout` gates on `onboarding_complete()` only — the same question `register_free()` asks — so an event-only account buys a ticket on the same terms it RSVPs |
| Two people buy the last available ticket simultaneously | Only one receives that last place | Both pass the pre-Stripe `event_capacity_state()` read; the capacity trigger's row lock on the event serialises the two `event_registrations` inserts and refuses the second. `stripe-checkout` catches that refusal, re-reads the capacity state, and answers 409 `{"reason":"sold_out"}` |
| Two people try to claim the final place | The other sees Sold out **and is not charged** | Stripe is not called on any path out of that branch. The refusal happens before a session exists, so there is nothing to charge and nothing to abandon |
| Buyer refreshes after paying | Purchase remains single, ticket recoverable | The `idempotency_key` is derived from event + person + ticket type + live registration id, is unique in Postgres, and is handed to Stripe, so a second create replays the first session. `event_tickets` is unique on `registration_id`, and the webhook's move to `paid` is conditional on `status = 'pending'`, so a replay issues no second ticket and queues no second email |
| Payment remains unresolved | A waiting/help state, not a false success | `stripe-checkout` returns `order_status: "pending"` and cannot write anything else — only `stripe-webhook` writes `paid`, and only against a signed Stripe event. Arriving at `success_url` proves a redirect was followed, nothing more |
| Attendee cancels a paid ticket | Entry and refund states separately understandable | `event-refund` never touches `event_registrations` and returns `registration_unchanged: true`; `cancel_registration` never touches money. "Your attendance is cancelled; your refund is processing" is two independent facts because they are two independent writes |
| A connector is restricted, or a paid ticket is added to a published free event | New sales stop; nothing already sold changes | The paid-sale gate runs at **every checkout**, not at publish. `event_sale_readiness()` is the one definition, shared with the publish check and the organiser's dashboard banner |
| Connector-hosted paid sales activated later | Revenue goes to the event's designated host account; fee/refund behaviour matches the event payment setup | The destination is read from `events.payment_connector_id` — the creator's answer — never from the caller. Direct charge on their `acct_…`: funds, Stripe's fees, refunds and disputes all theirs. Refunds route back through `event_orders.stripe_account_id` |
| QLT-09 operational recovery | Failed confirmations, missing tickets and failed refunds are findable | A paid-but-unconfirmable place writes an `event_refunds` row at `needs_attention`; a Stripe refund failure leaves the row `needs_attention` with Stripe's message on it; a paid session naming one of our orders that is missing raises a 500, so it sits in Stripe's failed-delivery list rather than scrolling past in a log |
| QLT-10 no false success, no duplicate charge | — | Named mechanism by mechanism in the header comment of `stripe-checkout/index.ts` |

**The one §11 payment row that is not mine:** *"make the responsible payment
account clear before sales open"* (BUY-14) is a screen, not an endpoint. I
return `connector_stripe_missing` and `connector_charges_disabled` with the
sentences to show, and `stripe-connect`'s `refresh` gives the connector screen
its live status — but the disclosure on the event page before sales open
belongs to the organiser and attendee workstreams.

---

## 9. When the webhook write fails after a real payment

The step most likely to fail, and the one where failing costs an attendee
money. Written out because "Stripe will retry" is not a complete answer.

### The window

Stripe delivers `checkout.session.completed` within seconds of the payment. If
our endpoint answers anything but a 2xx, Stripe retries with exponential
backoff for up to **three days** in live mode (test mode gives up after a
handful of attempts within a few hours). Every handler in `stripe-webhook` is
safe to run twice, which is what makes returning a 500 the right answer rather
than swallowing the failure with a 200 — a 200 tells Stripe never to come back.

So the outage has to last three days before the delivery is lost for good.
Almost every real failure — a deploy, a database blip, a Supabase incident —
is resolved by the retry with no human involved.

### What the attendee sees meanwhile

- They land on `/events/checkout/:slug?paid=1&session_id=…`. Their order is
  still `pending`, so the screen shows a **processing** state, not a ticket and
  not a success. `stripe-checkout` returns `order_status` and structurally
  cannot return anything but `pending`, so there is no code path by which a
  redirect alone reads as a completed purchase (BUY-03, BUY-04).
- Their place is still held. The registration is `pending` with
  `hold_expires_at` twenty minutes out.
- When the retry lands, the order goes `paid`, the ticket is issued and the
  confirmation is queued — exactly as if the first delivery had worked. They
  get their ticket late, not never.

### The twenty-minute problem, and what now closes it

Past twenty minutes the hold lapses, and that used to be a genuine
double-charge path: the attendee comes back, `stripe-checkout` sees an expired
`pending` registration, retires it, builds a fresh registration, a fresh
idempotency key and a fresh Checkout session — and takes their money a second
time for a place they had already bought. Postgres cannot see this, because our
own row says `pending` in both the abandoned case and the paid-but-unconfirmed
case.

`stripe-checkout` now asks Stripe before retiring any lapsed hold. If that
registration has a pending order with a session, the session is re-read on the
right account, and a `payment_status` of `paid` stops everything: the hold is
not retired, no second session is created, and the caller gets
`409 {"reason":"payment_confirming"}` with a sentence saying their payment went
through, their place is safe, and they have not been charged twice. The
discrepancy is logged with the session id and the registration id.

It does not confirm the order itself. `stripe-webhook` stays the only writer of
`paid`, and duplicating that logic here would create two things racing to issue
one ticket.

### What reconciles if Stripe exhausts its retries

**`stripe-reconcile`, every five minutes.** The sweep takes `event_orders` that
are `pending`, are older than their hold, and carry a
`stripe_checkout_session_id`; re-reads each session on its own
`stripe_account_id`; confirms the ones Stripe says are `paid` and fails the ones
Stripe says expired. It is the question `stripe-checkout` asks about one order
when an attendee returns to a lapsed hold, asked about all of them without
waiting for anybody to return.

It is **not** a second writer of `paid`. Both transitions live in
`supabase/functions/_shared/order-state.ts` and stripe-webhook calls the same
two functions. Each claims the row with `.eq('status', 'pending')`, so the sweep
and a late delivery racing over one order produce one confirmation, one ticket
and one email — whichever loses selects no row and stops. Two callers is safe;
two *implementations* would not be, which is why the logic moved out of
stripe-webhook rather than being copied.

What it deliberately leaves alone:

- **orders with no session id.** `stripe-checkout` writes the session id in a
  second statement after `sessions.create` returns, so a missing id can mean
  the session exists and the write was interrupted. Failing those blind would
  fail an order somebody has paid for.
- **orders still inside the twenty-minute hold** — somebody's live checkout.
- **sessions Stripe still calls `open`**, or `complete` with an asynchronous
  method still clearing. Nothing is decided until Stripe has decided it.

A confirmation arriving from the sweep rather than from a webhook means
deliveries are being lost, so it logs at error level with the session id, the
order id and the account. The backstops below all still apply and are what
covers an order the sweep will not touch:

- the `payment_confirming` refusal above, so the money is never taken twice and
  the place is never quietly re-sold;
- Stripe's own **failed-delivery list** on the webhook endpoint, which is where
  a paid session naming one of our orders ends up when the order cannot be
  found — a 500 keeps it there rather than letting it scroll past in a log;
- **Resend** on any of those deliveries from the Stripe dashboard, which runs
  the whole confirmation path again correctly, because every handler is
  idempotent.

### How it is scheduled, and when it is not

`pg_cron` + `pg_net`, from
`supabase/migrations/20260916000032_reconcile_pending_payments.sql` — the same
mechanism and the same two database settings the `event-mailer` schedule
already needs:

```sql
alter database postgres set app.settings.service_role_key = '...';
alter database postgres set app.settings.functions_url = 'https://<ref>.supabase.co/functions/v1';
```

Both extensions are absent on a local `supabase start` and on free projects, so
the migration is wrapped: without them it logs a notice and applies cleanly.
**Unlike the mailer there is no GitHub Actions fallback** — if the schedule
cannot be created the sweep does not run, and the position is exactly what this
section described before it existed: recoverable by a human from Stripe's
failed-delivery list. Check `cron.job` for a row named `stripe-reconcile` to
know which of the two you have.

`verify_jwt` is left **on** for this function, unlike `event-mailer` and
`stripe-webhook`. pg_cron calls it with the service-role key, which is itself a
valid project JWT, so the platform's own wall stands in front of it and there
is no new shared secret to set or rotate. The function then checks that the
bearer really is the service role — or that the caller is an admin, for a sweep
run by hand — because the anon key is also a valid JWT.

---

## 10. The offline check

One thing in this workstream can be verified with no key, no project and no
network — the signed OAuth `state`, which is the only security-critical logic
here, plus the money-status rules that are pure data:

```bash
deno run --allow-read scripts/check-connect-state.ts
# 46/46 checks passed
```

It asserts that a `state` re-aimed at another connector is refused, that one
signed with another key is refused, that an expired one is refused, that
rubbish is refused rather than thrown on, that `completed` is reachable from
Stripe's `succeeded` and nothing else, that `event-refund` cannot write
`completed` at all, that no function sets `application_fee_amount`, and that
`event-refund` reads the Stripe account off the order rather than the event.

Since the reconciliation sweep arrived it also asserts the shape that keeps two
callers safe: that the `pending -> paid` transition exists in exactly one
place, that both `confirmPaidOrder` and `failPendingOrder` claim their row
conditionally, that a confirmation which loses the claim stops before touching
the registration, that both stripe-webhook and stripe-reconcile go through the
shared functions rather than their own, and that the sweep reads each session
on the order's own Stripe account.

Those assertions are scoped to each function's body rather than run over the
whole file, because a whole-file regex passes as long as *some* function still
looks right — which is how the first version of the conditional-claim check
went green against a `confirmPaidOrder` whose guard had been deleted, matching
`failPendingOrder`'s guard instead. Each one was confirmed to fail against a
deliberately broken copy before being kept.

It reads the status maps and the transition bodies out of the function sources
rather than keeping its own copy, so an edit in production is an edit this
check sees. It runs in CI on every push that touches `supabase/` or `scripts/`
— see `.github/workflows/deploy-database.yml`, where nothing deploys until it
and `deno check` over all ten functions have passed.

---

## 11. What stays unverified until Stripe keys exist

Stated plainly, because a reader should not have to infer it.

**Never executed, by anybody, at the time of writing:** every line below that
talks to Stripe. The functions type-check and the offline logic above passes;
no Stripe API call in this codebase has been made.

| Unverified | Why, and what would prove it |
| --- | --- |
| That an admin cannot hijack a connector's payout account | The `consent_required` refusal is asserted statically. That Stripe returns the *caller's* account from `oauth.token`, which is the mechanism that made it a bug, has never been observed. |
| The whole OAuth loop | `stripe.oauth.token` and `stripe.oauth.deauthorize` need a real `ca_…` and a connector willing to click through. §6.4 step 1. |
| `redirect_uri` matching | Stripe string-matches it against the dashboard list. A mismatch is invisible until the first real exchange. |
| Direct charges landing in the connector's balance | The single most important claim in §7.1 and it can only be seen in the connector's own Stripe dashboard. §6.4 step 5. |
| That Stripe's fee comes out of the connector, not Amazing | Same place, same step. This is BUY-14's substance. |
| `constructEventAsync` against a genuine signature | The async/SubtleCrypto path is right by construction — Deno has no sync crypto — but no real signature has passed through it. |
| That connected-account deliveries arrive at all | Depends entirely on the §2.5 step 3 checkbox, which is dashboard state, not code. |
| Idempotency under a real Stripe retry | The Postgres side (conditional updates, partial unique indexes) is verifiable locally; Stripe's retry behaviour is not. |
| That a duplicate refund produces one payout, not two | The 409 is provable locally. That Stripe agrees needs §6.3's duplicate-refund pair against a real charge. |
| `account.updated` reflecting a real restriction | Needs an account Stripe has genuinely restricted, not a fixture. |
| The capacity race producing 409 rather than 500 | The trigger's rejection is caught by re-reading `event_capacity_state()`, which is correct whatever SQLSTATE the trigger raises — but the trigger does not exist yet (db workstream), so the branch has never been entered. |
| Delayed payment methods | `checkout.session.async_payment_*` are handled and subscribed, but unreachable until such a method is enabled in the dashboard. |
| The QLT-09 missing-order path | A paid session naming an order that is not there raises a 500 so Stripe keeps it in its failed-delivery list. Provable only by deleting an order mid-flight against a real payment. |
| The lapsed-hold paid-session guard | The extra `sessions.retrieve` on the expired-hold path has never run against a real session. It is the guard that stops a double charge after an undelivered webhook. |
| The reconciliation sweep confirming anything | `stripe-reconcile` has never read a real session. That two callers of `confirmPaidOrder` produce one ticket is asserted statically and rests on Postgres's conditional update, which is sound locally; the sweep actually finding a paid session Stripe never told us about is not reproducible without a deliberately broken endpoint and a real payment. §6.4 is where to add it. |
| That the sweep's schedule exists at all | `pg_cron` and `pg_net` are skipped on local and free projects, and the migration logs a notice rather than failing. Whether the job was created is a fact about the deployed project — `select * from cron.job where jobname = 'stripe-reconcile'`. |
| Stripe's actual retry schedule | Three days is Stripe's documented live-mode behaviour, not something observed here. |
| Currency behaviour beyond `gbp` | Only `gbp` has been reasoned about. Zero-decimal currencies (`jpy`) would need the minor-unit assumption re-checked before use. |

**What is *not* on this list, deliberately:** free events. They need no Stripe
configuration, touch none of these functions, and work today.
