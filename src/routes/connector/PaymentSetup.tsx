import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { DashboardShell } from '../../components/DashboardShell'
import {
  Button,
  ConfirmModal,
  Notice,
  Panel,
  SectionHeader,
  Spinner,
  formatDateTime,
} from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import { errorMessage, functionError, supabase } from '../../lib/supabase'
import { payoutState, type ConnectorPayments, type PayoutState } from './payouts'

/**
 * A super connector's own payment account. BUY-14, CONTRACT §7.1 and §7.3.
 *
 * The thing to hold on to while reading this file: the money for a connector's
 * event is never ours. Charges are direct charges on their Stripe account, so
 * the funds land in their balance, Stripe's fees come out of it, and disputes
 * and refunds are theirs. That is what BUY-14 asks for literally, and it is
 * why this screen exists at all — without a connected account there is nowhere
 * for a connector's ticket money to go, and paid events cannot be published.
 *
 * It is an OAuth connection. We store an account id (`acct_…`) and a cache of
 * what Stripe last told us about it. **We never see or store a secret key**,
 * and no connector configures a webhook of their own. If a field on this page
 * ever asks for a key, somebody has misread §7.1.
 *
 * Every write goes through the `stripe-connect` edge function on the service
 * role: `connectors_update` is admin-only, so a connector cannot PATCH their
 * own Stripe columns, which is deliberate.
 */

const TONE: Record<string, string> = {
  ready: 'text-positive border-[#b9d8c4] bg-[#eff8f2]',
  waiting: 'text-[#8a4b00] border-[#efc98f] bg-gold-wash',
  none: 'text-dim border-line bg-raised',
}

/** QLT-02. The state in words, never only in a colour. */
export function PayoutBadge({ state }: { state: PayoutState }) {
  const tone = state.canSellPaid
    ? 'ready'
    : state.fix === 'connect'
      ? 'none'
      : 'waiting'
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-wide whitespace-nowrap ${TONE[tone]}`}
    >
      {state.headline}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Talking to the edge function                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every Stripe Connect action in one place. The function runs on the service
 * role and is the only writer of the Stripe columns.
 */
async function connect(
  action: 'start' | 'callback' | 'refresh' | 'disconnect',
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('stripe-connect', {
    body: { action, ...body },
  })
  if (error) throw new Error(await functionError(error))
  return (data ?? {}) as Record<string, unknown>
}

/*
 * There is deliberately no return URL to pass. The redirect Stripe uses is
 * registered in the Stripe dashboard and is built server-side by
 * stripe-connect (`${SITE_URL}/connector/stripe/return`); Stripe refuses the
 * exchange if what we send is not on its list, so the browser is not allowed
 * to choose it.
 */

/* -------------------------------------------------------------------------- */
/* The panel                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The body of the screen, without the page chrome, so the connector dashboard
 * can show the same thing inside its Payments tab without a second copy of it.
 */
export function PaymentsPanel({
  connector,
  onChanged,
}: {
  connector: ConnectorPayments
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState<'start' | 'refresh' | 'disconnect' | null>(null)
  const [error, setError] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const state = payoutState(connector)
  const connected = Boolean(connector.stripe_account_id) && state.fix !== 'connect'

  /*
   * §7.3. What Stripe will let an account do changes without telling us — a
   * document expires, a verification comes through — so the screen asks Stripe
   * once when it opens rather than showing a cache that could be days old.
   *
   * Quiet on purpose. A failure here costs freshness, not the page: the stored
   * columns are still shown, and the Refresh button is still there. The webhook
   * keeps the same columns up to date when nobody is looking.
   */
  const refreshed = useRef(false)
  useEffect(() => {
    if (refreshed.current || !connector.stripe_account_id) return
    refreshed.current = true
    void connect('refresh')
      .then(() => onChanged())
      .catch((err) => console.error('[amazing] could not refresh the Stripe status:', err))
  }, [connector.stripe_account_id, onChanged])

  async function run(action: 'start' | 'refresh' | 'disconnect') {
    setError('')
    setBusy(action)
    try {
      if (action === 'start') {
        const data = await connect('start')
        const url = typeof data.url === 'string' ? data.url : ''
        if (!url) {
          throw new Error(
            'Stripe did not send back a link to continue at. Nothing has changed — try again in a moment.',
          )
        }
        // A full navigation: this leaves the application for Stripe's own
        // hosted onboarding, which is the only place their details are typed.
        window.location.assign(url)
        return
      }
      await connect(action)
      setConfirmDisconnect(false)
      await onChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-10 space-y-8">
      {/*
        §7.1, in the words the connector needs rather than the words Stripe
        uses. Revenue, fees, refunds and disputes are theirs. Saying so here
        is not decoration: it is the difference between them understanding
        that a chargeback comes out of their balance and being surprised by it.
      */}
      <Panel className="px-6 py-6">
        <p className="eyebrow">Your events, your Stripe account, your money</p>
        <div className="mt-4 space-y-3 text-sm leading-relaxed text-muted">
          <p>
            When you host a paid event, the ticket money is charged on{' '}
            <span className="font-medium text-fg">your own Stripe account</span> and lands in
            your balance. Stripe&rsquo;s processing fees come out of it, refunds come out of
            it, and any dispute a guest raises is yours to answer. Amazing takes no
            commission on your events.
          </p>
          <p>
            Connecting is an authorisation, not a handover.{' '}
            <span className="font-medium text-fg">
              We never see or store your Stripe secret key.
            </span>{' '}
            We hold your account id so a ticket sale can be charged to it, and nothing else.
            You can disconnect at any time.
          </p>
        </div>
      </Panel>

      {/*
        ORG-01A. If an administrator has not switched event creation on, Stripe
        is not what stands in their way, and a Connect button presented as the
        blocker would send them chasing the wrong thing.
      */}
      {!connector.can_create_events && (
        <Notice tone="error">
          <strong>Your account is not set up to create events yet.</strong> An administrator
          switches that on, and it is the first of the two things needed &mdash; Stripe is
          the second. Connecting a Stripe account is not what is standing in your way, and
          it would be refused until the permission exists, so there is nothing useful to do
          on this page yet. Ask an administrator, and come back.
        </Notice>
      )}

      <div>
        <SectionHeader
          title="Payment account"
          caption="Where the money for your paid events is charged and held."
          action={
            connected ? (
              <Button
                size="sm"
                loading={busy === 'refresh'}
                onClick={() => void run('refresh')}
              >
                Refresh status
              </Button>
            ) : undefined
          }
        />

        {error && (
          <div className="mb-4">
            <Notice tone="error">{error}</Notice>
          </div>
        )}

        <Panel className="px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-fg">{state.headline}</div>
              <div className="mt-1 truncate text-xs text-dim">
                {connector.stripe_account_id
                  ? `Stripe account ${connector.stripe_account_id}`
                  : 'No Stripe account connected'}
              </div>
            </div>
            <PayoutBadge state={state} />
          </div>

          {/* §7.3. When it is not ready, say what is outstanding — not that
              "something went wrong". A person can act on the first. */}
          {state.outstanding && (
            <p className="mt-5 text-sm leading-relaxed text-muted">{state.outstanding}</p>
          )}

          {state.canSellPaid && !state.outstanding && (
            <p className="mt-5 text-sm leading-relaxed text-muted">
              Paid tickets can go on sale. Charges are taken on this account and paid out to
              the bank details you gave Stripe.
            </p>
          )}

          <div className="mt-6 flex flex-wrap gap-3">
            {/* ORG-01A. stripe-connect refuses `start` outright for a connector
                who may not create events, so the button is not offered: a
                button that returns a refusal is the dead blocker we were told
                not to draw. The notice above says who to ask instead. */}
            {connector.can_create_events && (state.fix === 'connect' || state.fix === 'continue') && (
              <Button
                variant="primary"
                size="sm"
                loading={busy === 'start'}
                onClick={() => void run('start')}
              >
                {state.fix === 'continue' ? 'Continue on Stripe' : 'Connect Stripe'}
              </Button>
            )}
            {state.fix === 'stripe' && (
              <a
                href="https://dashboard.stripe.com/"
                target="_blank"
                rel="noreferrer noopener"
              >
                <Button variant="primary" size="sm">
                  Finish this on Stripe
                </Button>
              </a>
            )}
            {connected && (
              <Button size="sm" variant="danger" onClick={() => setConfirmDisconnect(true)}>
                Disconnect
              </Button>
            )}
          </div>

          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-1 text-xs text-dim">
            {connector.stripe_connected_at && (
              <span>Connected {formatDateTime(connector.stripe_connected_at)}</span>
            )}
            {connector.stripe_checked_at && (
              <span>Last checked with Stripe {formatDateTime(connector.stripe_checked_at)}</span>
            )}
            <span>
              Payouts to your bank{' '}
              {connector.stripe_payouts_enabled ? 'enabled' : 'not enabled yet'}
            </span>
          </div>
        </Panel>

        {/*
          §7.3, rows two and three. Both gates in one sentence each, so it is
          obvious which one is missing and what it costs them today.
        */}
        <Panel className="mt-4 border-dashed px-5 py-4 text-xs leading-relaxed text-muted">
          {connector.can_create_events && !state.canSellPaid && (
            <>
              You can create and publish <span className="font-medium text-fg">free</span>{' '}
              events today. Paid events open the moment this account is connected and Stripe
              is happy with it &mdash; nothing else is needed from an administrator.
            </>
          )}
          {connector.can_create_events && state.canSellPaid && (
            <>
              Both gates are open: you may create events, and you may charge for them. The
              price and the currency are set per ticket type when you build the event.
            </>
          )}
          {!connector.can_create_events && (
            <>
              Two separate things have to be true before you can sell a ticket: an
              administrator switches on event creation for your account, and this Stripe
              account is connected and ready. Neither grants the other.
            </>
          )}
        </Panel>
      </div>

      <ConfirmModal
        open={confirmDisconnect}
        title="Disconnect your Stripe account?"
        body={
          <>
            <p>
              New paid tickets stop being sold on your events straight away. Free events are
              not affected.
            </p>
            <p className="mt-3">
              Nothing that has already happened is undone.{' '}
              <span className="font-medium text-fg">
                Existing bookings, the tickets issued for them, check-in on the door and
                refunds on payments already taken all keep working
              </span>{' '}
              &mdash; every refund goes back through the account that originally took the
              money, which does not change when you disconnect.
            </p>
            <p className="mt-3">You can reconnect at any time.</p>
          </>
        }
        confirmLabel="Disconnect Stripe"
        busy={busy === 'disconnect'}
        error={error}
        onConfirm={() => void run('disconnect')}
        onClose={() => setConfirmDisconnect(false)}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* The screen                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `/connector/payments`, and `/connector/stripe/return` — the address Stripe
 * sends the browser back to after OAuth. One component for both: the return is
 * this same page with one extra job to do before it renders, and a second
 * screen that only said "one moment" would be a second screen to maintain.
 */
export default function PaymentSetup() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [params] = useSearchParams()

  const [connector, setConnector] = useState<ConnectorPayments | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const returning = pathname.startsWith('/connector/stripe/return')
  const [finishing, setFinishing] = useState(returning)
  // The callback must be exchanged once. A second exchange of the same code is
  // refused by Stripe, and React mounts an effect twice in development.
  const exchanged = useRef(false)

  const load = useCallback(async () => {
    if (!profile) return
    const { data, error: loadError } = await supabase
      .from('connectors')
      .select('*')
      .eq('profile_id', profile.id)
      .maybeSingle()

    if (loadError || !data) {
      setError(errorMessage(loadError) || 'No connector record found for this account.')
    } else {
      setConnector(data as ConnectorPayments)
    }
    setLoading(false)
  }, [profile])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * Stripe hands back either an authorisation code or a refusal. Exchange the
   * code through the edge function — it is the only thing holding our platform
   * key — then drop the query string, which contains a single-use credential
   * and has no business staying in the address bar or in a bookmark.
   */
  useEffect(() => {
    if (!returning || exchanged.current) return
    exchanged.current = true

    const code = params.get('code')
    const refusal = params.get('error_description') ?? params.get('error')

    void (async () => {
      if (!code) {
        setError(
          refusal
            ? `Stripe did not complete the connection: ${refusal}`
            : 'Stripe sent you back without completing the connection. Nothing has changed.',
        )
      } else {
        try {
          await connect('callback', { code, state: params.get('state') })
        } catch (err) {
          setError(errorMessage(err))
        }
      }
      await load()
      setFinishing(false)
      navigate('/connector/payments', { replace: true })
    })()
  }, [returning, params, load, navigate])

  return (
    <DashboardShell
      title="Payments"
      caption="Your Stripe account, and what it lets your events do. Amazing never holds your keys or your money."
    >
      {loading || finishing ? (
        <div className="flex justify-center py-16 text-dim">
          <Spinner />
        </div>
      ) : (
        <>
          {error && (
            <div className="mb-6">
              <Notice tone="error">{error}</Notice>
            </div>
          )}
          {connector && <PaymentsPanel connector={connector} onChanged={load} />}
        </>
      )}
    </DashboardShell>
  )
}
