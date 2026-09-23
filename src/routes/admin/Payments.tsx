import { useCallback, useEffect, useState } from 'react'
import { Button, CopyCode, EmptyState, Notice, Panel, Spinner } from '../../components/ui'
import { errorMessage, supabase } from '../../lib/supabase'

/**
 * Whether Amazing can take money, and what to run if it cannot.
 *
 * §12 wants operating instructions for the administrator; QLT-02 wants a
 * problem explained plainly with somewhere to go. Before this, the first sign
 * that Stripe was unconfigured was an attendee meeting `stripe_not_configured`
 * in checkout — the worst possible place and the worst possible person.
 *
 * **This screen cannot set anything, deliberately.** BUY-13 puts Amazing's own
 * Stripe account behind admin-hosted events, so there is one platform key, and
 * it lives in Supabase's secret store where it is encrypted at rest and
 * injected into the edge runtime as an environment variable. A form that
 * accepted a secret key would put it in a browser, in the page's memory, in
 * the network tab, and in whatever screen recording is running. So the
 * commands are printed to copy and the values are never handled here.
 *
 * Nothing on this page has ever seen key material. `payments-status` returns
 * booleans and a test/live mode, and there is no field it could put a key in.
 */

interface SecretState {
  set: boolean
  mode?: 'test' | 'live' | null
}

interface Status {
  secrets: {
    STRIPE_SECRET_KEY: SecretState
    STRIPE_WEBHOOK_SECRET: SecretState
    STRIPE_CONNECT_CLIENT_ID: SecretState
    STRIPE_CONNECT_STATE_SECRET: SecretState
    SITE_URL: string | null
    PLATFORM_FEE_BPS: number
  }
  account: {
    reachable: boolean
    id: string | null
    charges_enabled: boolean | null
    payouts_enabled: boolean | null
    error: string | null
  }
  webhook: {
    checked: boolean
    found: boolean
    status: string | null
    missing_events: string[]
    error: string | null
  }
  connected_accounts_checkable: boolean
}

/** The secrets, in the order somebody sets them up. */
const WHAT_FOR: { key: keyof Status['secrets']; label: string; needed?: string }[] = [
  { key: 'STRIPE_SECRET_KEY', label: 'Secret key' },
  { key: 'STRIPE_WEBHOOK_SECRET', label: 'Webhook secret' },
  { key: 'STRIPE_CONNECT_CLIENT_ID', label: 'Connect client id' },
  { key: 'STRIPE_CONNECT_STATE_SECRET', label: 'Connect state secret', needed: 'Optional.' },
]

function Row({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  // QLT-04: the word carries the state, never the colour on its own.
  const word = ok === null ? 'Unknown' : ok ? 'Set' : 'Missing'
  const tone = ok === null ? 'text-dim' : ok ? 'text-positive' : 'text-negative'
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-fg">{label}</div>
        {detail && <div className="text-xs leading-relaxed text-dim">{detail}</div>}
      </div>
      <div className={`shrink-0 text-xs font-semibold ${tone}`}>{word}</div>
    </div>
  )
}

export default function Payments() {
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    setLoadError('')
    const { data, error } = await supabase.functions.invoke('payments-status', { body: {} })
    if (error) {
      setLoadError(errorMessage(error))
      setStatus(null)
    } else {
      setStatus(data as Status)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-dim">
        <Spinner />
      </div>
    )
  }

  const s = status?.secrets
  const liveMode = s?.STRIPE_SECRET_KEY.mode === 'live'

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={() => void load()}>
          Re-check
        </Button>
      </div>

      {loadError && (
        <div className="mb-6">
          <Notice tone="error">{loadError}</Notice>
        </div>
      )}

      {!status ? (
        <EmptyState>
          Could not read the payment configuration. Existing tickets and bookings are
          unaffected. Press Re-check to try again.
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {/* Only a problem earns a headline; test mode has its own below. */}
          {!s?.STRIPE_SECRET_KEY.set ? (
            <Notice tone="error">
              Stripe is not configured, so no paid event can sell a ticket. Free events are
              unaffected and work normally.
            </Notice>
          ) : !status.account.reachable ? (
            <Notice tone="error">
              A secret key is set but Stripe refused it, so no paid event can sell a ticket.
              {status.account.error ? ` Stripe said: ${status.account.error}` : ''}
            </Notice>
          ) : status.account.charges_enabled ? null : (
            <Notice tone="warning">
              Stripe accepted the key, but this account cannot currently take charges. Check
              for outstanding verification in the Stripe dashboard.
            </Notice>
          )}

          {/* Test vs live is the mistake worth shouting about: everything looks
              correct in test mode right up until nobody's money arrives. */}
          {s?.STRIPE_SECRET_KEY.set && !liveMode && (
            <Notice tone="warning">
              These are <strong>test</strong> keys. Tickets can be bought with Stripe&rsquo;s test
              cards and no real money moves. Swap in the live keys when you are ready to sell.
            </Notice>
          )}

          <Panel className="divide-y divide-line">
            {WHAT_FOR.map((row) => {
              const value = s?.[row.key] as SecretState | undefined
              return (
                <Row
                  key={row.key}
                  ok={value?.set ?? null}
                  label={row.label}
                  detail={row.needed}
                />
              )
            })}
            <Row
              ok={Boolean(s?.SITE_URL)}
              label="Site address"
              detail={
                s?.SITE_URL
                  ? `${s.SITE_URL}. It must match the redirect URI registered in Stripe, character for character.`
                  : 'Defaults to https://goamazing.ai.'
              }
            />
            <Row
              ok
              label="Booking fee"
              detail={
                s?.PLATFORM_FEE_BPS
                  ? `${s.PLATFORM_FEE_BPS} basis points`
                  : 'None'
              }
            />
          </Panel>

          {/* The webhook is the half that decides whether a payment is ever
              confirmed, and it fails silently — the buyer is charged and the
              order sits pending. Worth its own block. */}
          <div>
            <h2 className="eyebrow mb-3">Confirming payments</h2>
            <Panel className="divide-y divide-line">
              <Row
                ok={status.webhook.checked ? status.webhook.found : null}
                label="Webhook endpoint"
                detail={
                  !status.webhook.checked
                    ? 'Set the secret key, then press Re-check.'
                    : status.webhook.error
                      ? `Could not ask Stripe: ${status.webhook.error}`
                      : status.webhook.found
                        ? undefined
                        : 'No endpoint pointing at stripe-webhook. Payments would be taken and never confirmed.'
                }
              />
              {status.webhook.found && (
                <Row
                  ok={status.webhook.missing_events.length === 0}
                  label="Subscribed events"
                  detail={
                    status.webhook.missing_events.length === 0
                      ? undefined
                      : `Not subscribed to: ${status.webhook.missing_events.join(', ')}. Each one is a case that will silently not happen.`
                  }
                />
              )}
              {!status.connected_accounts_checkable && (
                <div className="px-5 py-4">
                  <div className="text-sm font-medium text-fg">Events on connected accounts</div>
                  <div className="mt-1 text-xs leading-relaxed text-dim">
                    Cannot be checked from here. In the Stripe dashboard, turn on &ldquo;Listen
                    to events on connected accounts&rdquo; on the webhook endpoint. With it off,
                    buyers of connector events are charged but never get their place.
                  </div>
                </div>
              )}
            </Panel>
          </div>

          <div>
            <h2 className="eyebrow mb-3">Setting or changing a key</h2>
            <p className="mb-4 max-w-2xl text-sm leading-relaxed text-muted">
              Run these with the Supabase CLI, then press Re-check. Never paste a key into
              this site.
            </p>
            <CopyCode
              code={`supabase secrets set STRIPE_SECRET_KEY=sk_test_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set STRIPE_CONNECT_CLIENT_ID=ca_...
supabase secrets set SITE_URL=https://goamazing.ai`}
            />
            <p className="mt-4 max-w-2xl text-xs leading-relaxed text-dim">
              Where to find each value: docs/event-platform/PAYMENTS.md §2. Test and live mode
              have separate keys, client ids and webhook endpoints, so do this once per mode.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
