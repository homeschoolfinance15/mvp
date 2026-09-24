# stripe-sim — local-only fake Stripe

A single-file Node server (no dependencies) that stands in for the Stripe
endpoints `supabase/functions/*` call, so the payment flow can be run end to
end against the local Supabase stack with no Stripe account and no network.

**Local only.** It never contacts Stripe. It refuses `sk_live_` keys. The
functions only reach it when `STRIPE_API_BASE` is set (see
`supabase/functions/_shared/stripe.ts`); production never sets that variable.

## Run

```sh
node scripts/stripe-sim/server.mjs          # listens on 0.0.0.0:12111
node scripts/stripe-sim/selftest.mjs        # 30 checks, uses port 12199
```

Env (all optional):

| var | default |
| --- | --- |
| `PORT` | `12111` |
| `WEBHOOK_URL` | `http://127.0.0.1:54321/functions/v1/stripe-webhook` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_local_sim` (must match the functions' env) |
| `SIM_LOG` | `scripts/stripe-sim/out/stripe-requests.jsonl` (git-ignored) |
| `SIM_PUBLIC_BASE` | `http://localhost:$PORT` (base of the session `url`) |
| `SIM_PLATFORM_ACCOUNT` | `acct_sim_platform` |

Functions env (`supabase functions serve --env-file …`):
`STRIPE_SECRET_KEY=sk_test_sim`, `STRIPE_WEBHOOK_SECRET=whsec_local_sim`,
`STRIPE_API_BASE=http://host.docker.internal:12111`.

## Stripe endpoints

`POST/GET /v1/checkout/sessions[/:id]`, `POST /v1/checkout/sessions/:id/expire`,
`POST/GET /v1/refunds[/:id]`, `GET /v1/payment_intents/:id`, `GET /v1/account`,
`GET /v1/accounts/:id`, `GET /v1/webhook_endpoints`, `POST /oauth/token`,
`POST /oauth/deauthorize`.

Behaves like Stripe where it matters to this codebase:

- Form bodies decoded the way stripe-node encodes them (`a[b][0][c]=v`).
- `Stripe-Account` scopes every object: a session, intent or refund made on
  `acct_X` is `resource_missing` from any other account — so a refund sent to
  the wrong account fails here as it would at Stripe.
- `Idempotency-Key` replays the first response (per account).
- A payment-mode session has `payment_intent: null` until paid (Stripe API
  ≥ 2022-08-01); `amount_total` is the sum of line items.
- Refunds are created `pending`; over-refunds get `amount_too_large`.
- Webhooks are signed `t=<unix>,v1=<hex HMAC-SHA256(secret, t.payload)>`, and
  Connect events carry `"account": "acct_…"`; platform events do not.

**OAuth caveat.** stripe-node 18 sends `stripe.oauth.*` to the hard-coded host
`connect.stripe.com` (`resources/OAuth.js`), ignoring the client's `host`. The
sim implements `/oauth/*`, but the SDK will not reach it through
`STRIPE_API_BASE`. Local tests should link a connector by writing
`connectors.stripe_account_id` directly, or route OAuth through the sim
explicitly. A code named `acct_…` connects that account id.

## Control API (not Stripe)

| request | effect |
| --- | --- |
| `GET /pay/:id` | HTML checkout page: **Pay**, **Pay (delayed method)**, **Decline** |
| `POST /pay/:id` `action=pay\|pay_async\|decline` (form or JSON) | pay → `checkout.session.completed` (paid), 303 to `success_url`; pay_async → completed but `unpaid`; decline → `checkout.session.expired`, 303 to `cancel_url` |
| `POST /_sim/session/:id/{pay\|pay_async\|async_succeed\|async_fail\|expire}` | same outcomes without a redirect; async_* send `checkout.session.async_payment_{succeeded,failed}` |
| `POST /_sim/refund/:id/{succeed\|fail}` | moves a pending refund, sends `refund.updated` |
| `POST /_sim/account/:id` `{charges_enabled, payouts_enabled, details_submitted, requirements, silent?}` | updates the account, sends `account.updated` |
| `POST /_sim/webhook` `{type, object, account?}` | sends any signed event |
| `GET /_sim/ledger` | who received each charge, gross, assumed Stripe fee, net, platform application fee, refunds |
| `GET /_sim/state` | every session, intent, refund, account |

## Fee ledger — assumptions

Stripe's processing fee is charged to the account that receives the charge
(the connected account for a direct charge). The rates are **assumptions**, in
one place, `FEE_ASSUMPTIONS` in `server.mjs`: GBP 1.5% + 20p (standard UK
card), EUR 1.5% + €0.25, USD 2.9% + 30¢, rounded to the minor unit. Refunds are
assumed not to return the original fee. The application fee is whatever the
request carried in `payment_intent_data.application_fee_amount` (the codebase
sends none, so 0).

Every request and webhook delivery is appended to `SIM_LOG` as JSON lines
(`kind`, `method`, `path`, `stripe_account`, `idempotency_key`, parsed `body`,
`status`; webhooks log `type`, `account`, and the receiver's response).

## Scenarios: the whole payment flow, end to end

```sh
supabase start                                   # Docker must be running
bash scripts/stripe-sim/scenarios/run-all.sh     # ~3 min, prints pass/fail per batch
```

It starts the simulator and `supabase functions serve` itself, builds a fresh
cast (admin, connector, members, guests) and events through the real RPCs,
then runs six batches in the order they depend on. Results, state and the
money table (`ledger.md`) land in `scripts/stripe-sim/out/`.

| Batch | Covers |
| --- | --- |
| `scen1` | Paid checkout on the platform and a connector account, GBP/EUR/USD, webhook replays, hold expiry, decline, last-place race, bad signatures |
| `scen2` | Full, partial and remainder refunds, a cancelled event, a lapsed hold resold |
| `scen3a`–`c` | Webhook deliveries lost while functions are down, then recovered by retry and `stripe-reconcile`; the booking fee (`env.sim.fee500`) |
| `scen4` | Refunds after the account is restricted or disconnected; Results figures against the ledger |
| `scen5` | `payment_failed` on a pending order; a paid session for the wrong amount |
| `scen6` | Stripe's fee recorded per order, delayed methods, reconcile backfill, no overwrite |

Local only: it uses the Supabase CLI's public demo keys and writes to the
local database. It stops the edge runtime container between batches.

