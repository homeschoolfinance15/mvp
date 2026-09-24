import { useCallback, useEffect, useState } from 'react'
import { Button, ConfirmModal, EmptyState, Field, Input, Notice, Panel, Spinner } from '../../components/ui'
import { errorMessage, supabase } from '../../lib/supabase'

/**
 * Whether Amazing can take money, and what to run if it cannot.
 *
 * §12 wants operating instructions for the administrator; QLT-02 wants a
 * problem explained plainly with somewhere to go. Before this, the first sign
 * that Stripe was unconfigured was an attendee meeting `stripe_not_configured`
 * in checkout — the worst possible place and the worst possible person.
 *
 * **Keys are set here, and never shown again.** BUY-13 puts Amazing's own
 * Stripe account behind admin-hosted events, so there is one platform key.
 * An administrator pastes it into the form below; set_stripe_setting() stores
 * it encrypted in Supabase Vault, and from then on the page can only learn
 * whether it is set, its last four characters and when it changed. The key
 * passes through this browser once, on the way in — the trade-off the owner
 * chose over running the Supabase CLI. The field is a password field and is
 * emptied the moment the save succeeds.
 *
 * `payments-status` still returns only booleans and a test/live mode.
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

        </div>
      )}

      <div className="mt-8">
        <StripeKeys onSaved={() => void load()} />
      </div>
    </>
  )
}

/** The three values an administrator can set here, in setup order. */
const KEYS = [
  {
    name: 'STRIPE_SECRET_KEY',
    label: 'Secret key',
    where: 'Stripe → Developers → API keys. Starts sk_live_ or sk_test_ (or rk_ for a restricted key).',
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    label: 'Webhook signing secret',
    where: 'Stripe → Developers → Webhooks → the stripe-webhook endpoint → Signing secret. Starts whsec_.',
  },
  {
    name: 'STRIPE_CONNECT_CLIENT_ID',
    label: 'Connect client id',
    where: 'Stripe → Settings → Connect → Onboarding options → OAuth. Starts ca_.',
  },
] as const

interface SavedKey {
  name: string
  is_set: boolean
  last4: string | null
  updated_at: string | null
}

/**
 * Write-only. What comes back from the database is set/not set, the last four
 * characters and when; the value itself never returns to a browser.
 */
function StripeKeys({ onSaved }: { onSaved: () => void }) {
  const [saved, setSaved] = useState<SavedKey[]>([])
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<Record<string, string>>({})
  const [done, setDone] = useState('')
  const [clearing, setClearing] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('stripe_settings_status')
    if (error) setProblem({ _: errorMessage(error) })
    else setSaved((data as SavedKey[]) ?? [])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function save(name: string, value: string | null) {
    setBusy(name)
    setDone('')
    setProblem((p) => ({ ...p, [name]: '' }))
    const { error } = await supabase.rpc('set_stripe_setting', { p_name: name, p_value: value })
    setBusy(null)
    if (error) {
      setProblem((p) => ({ ...p, [name]: errorMessage(error) }))
      return false
    }
    setTyped((t) => ({ ...t, [name]: '' }))
    setDone(value === null ? 'Cleared.' : 'Saved. It is used within a minute; press Re-check to confirm Stripe accepts it.')
    await load()
    onSaved()
    return true
  }

  return (
    <div>
      <h2 className="eyebrow mb-3">Stripe keys</h2>
      <p className="mb-4 max-w-2xl text-sm leading-relaxed text-muted">
        Paste each key and save. Keys are stored encrypted and never shown again. Test and live
        mode have separate keys; paste the set for the mode you want to run.
      </p>
      {problem._ && (
        <div className="mb-4">
          <Notice tone="error">{problem._}</Notice>
        </div>
      )}
      {done && (
        <div className="mb-4">
          <Notice tone="success">{done}</Notice>
        </div>
      )}
      <Panel className="divide-y divide-line">
        {KEYS.map((k) => {
          const row = saved.find((r) => r.name === k.name)
          const value = typed[k.name] ?? ''
          return (
            <form
              key={k.name}
              className="px-5 py-5"
              onSubmit={(e) => {
                e.preventDefault()
                if (value.trim()) void save(k.name, value)
              }}
            >
              <Field
                label={k.label}
                hint={
                  row?.is_set
                    ? `Saved, ending ${row.last4}, on ${new Date(row.updated_at!).toLocaleString()}. Paste a new one to replace it. ${k.where}`
                    : k.where
                }
                error={problem[k.name]}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={value}
                  onChange={(e) => setTyped((t) => ({ ...t, [k.name]: e.target.value }))}
                  placeholder={row?.is_set ? `•••• ${row.last4}` : undefined}
                />
              </Field>
              <div className="mt-3 flex gap-2">
                <Button type="submit" size="sm" loading={busy === k.name} disabled={!value.trim()}>
                  Save
                </Button>
                {row?.is_set && (
                  <Button type="button" size="sm" onClick={() => setClearing(k.name)}>
                    Clear
                  </Button>
                )}
              </div>
            </form>
          )
        })}
      </Panel>

      <ConfirmModal
        open={clearing !== null}
        title={`Clear the saved ${KEYS.find((k) => k.name === clearing)?.label.toLowerCase() ?? 'key'}?`}
        confirmLabel="Clear it"
        busy={busy === clearing}
        error={clearing ? problem[clearing] : undefined}
        onConfirm={() => {
          if (clearing) void save(clearing, null).then((ok) => ok && setClearing(null))
        }}
        onClose={() => setClearing(null)}
        body="Payments fall back to the key set on the Supabase project, if there is one. With neither, paid events stop selling until a key is saved again."
      />
    </div>
  )
}
