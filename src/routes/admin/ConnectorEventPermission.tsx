import { useState } from 'react'
import { ConfirmModal, Notice, formatDateTime } from '../../components/ui'
import { errorMessage, supabase } from '../../lib/supabase'
import { PayoutBadge } from '../connector/PaymentSetup'
import { payoutState, type ConnectorPayments } from '../connector/payouts'

/**
 * The switch that makes a connector a super connector. ACC-04, ORG-01A/B/C.
 *
 * "Super connector" is the client's word for a connector an administrator has
 * allowed to put events on the calendar, so it is the word on screen. It is a
 * label rather than a role: `app_role` is untouched, because that enum is read
 * by every policy, guard and dashboard in the application.
 *
 * Off for everybody until an administrator turns it on — the column defaults
 * to false, so running the migration granted nothing to anybody.
 *
 * Two things sit here deliberately:
 *
 *   1. **Both gates, side by side.** Permission and a working Stripe account
 *      are the two things standing between a connector and selling a ticket
 *      (§7.3), and an admin asked "why can't they charge for this" needs to
 *      see which one is missing without opening a second screen or signing in
 *      as somebody else.
 *   2. **What switching off does not do.** ORG-01C. Turning the permission off
 *      blocks new creation and a first publish. It deletes nothing, cancels
 *      nothing, and leaves every event they already host entirely theirs to
 *      run. That sentence belongs at the moment of switching, not in a manual.
 *
 * There is no per-event approval queue here or anywhere else. ORG-01B excludes
 * one on purpose: permission is granted to a person, once, not to each event
 * they think of.
 */

/** What the admin dashboard hands down: the connector row plus its profile. */
export interface ConnectorWithProfile extends ConnectorPayments {
  profiles: { full_name: string } | null
}

export function ConnectorEventPermission({
  connector,
  changedByName,
  onChanged,
}: {
  connector: ConnectorWithProfile
  /** ORG-01A. Who last moved it — resolved from the admin's profile map. */
  changedByName: string | null
  onChanged: () => Promise<void>
}) {
  // Nothing is written until the dialog is confirmed, so the checkbox keeps
  // showing what is actually stored. Same rule as the status selects above it.
  const [pending, setPending] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const name = connector.profiles?.full_name ?? 'this connector'
  const payout = payoutState(connector)
  const on = connector.can_create_events

  async function apply() {
    if (pending === null) return
    setError('')
    setBusy(true)
    // events_permission_changed_by / _at are stamped by a database trigger, so
    // they cannot be forgotten here or backdated from a browser.
    const { error: updateError } = await supabase
      .from('connectors')
      .update({ can_create_events: pending })
      .eq('id', connector.id)
    setBusy(false)
    if (updateError) {
      setError(errorMessage(updateError))
      return
    }
    setPending(null)
    await onChanged()
  }

  return (
    <div className="border-t border-line bg-fg/[0.015] px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={on}
            onChange={() => setPending(!on)}
            className="size-4 accent-gold"
          />
          <span className="font-medium text-fg">Super connector</span>
          <span className="text-xs text-dim">may create and publish events</span>
        </label>

        <span className="flex items-center gap-2 text-xs text-dim">
          <PayoutBadge state={payout} />
          {on && !payout.canSellPaid && <span>free events only</span>}
        </span>

        <span className="ml-auto text-xs text-dim">
          {connector.events_permission_changed_at
            ? `${on ? 'Granted' : 'Withdrawn'} by ${changedByName ?? 'an administrator'} · ${formatDateTime(connector.events_permission_changed_at)}`
            : 'Never changed'}
        </span>
      </div>

      {/*
        The admin's read of the connector's payment setup, without impersonating
        them. Only shown when something is outstanding — when it is ready there
        is nothing to say that the badge has not already said.
      */}
      {on && payout.outstanding && (
        <p className="mt-2.5 text-xs leading-relaxed text-muted">{payout.outstanding}</p>
      )}

      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <ConfirmModal
        open={pending !== null}
        title={
          pending
            ? `Let ${name} create events?`
            : `Stop ${name} creating new events?`
        }
        body={
          pending ? (
            <>
              <p>
                {name} will be able to create and publish events with no further approval.
              </p>
              <p className="mt-3">
                <span className="font-medium text-fg">
                  Nothing is published by turning this on.
                </span>
              </p>
              {/*
                ACC-04, last sentence: hosting an event must not grant permission
                to manage another connector's network. Worth saying at the moment
                of granting, because "they can host now" is easy to hear as
                "they can do more now" generally.
              */}
              <p className="mt-3">
                Their invitation capacity and network access do not change.
              </p>
              <p className="mt-3">
                {payout.canSellPaid
                  ? 'Their Stripe account is ready, so they can sell paid tickets. The money goes to them, not to Amazing.'
                  : `Free events only until their Stripe account is ready — ${payout.headline.toLowerCase()} at the moment.`}
              </p>
            </>
          ) : (
            <>
              <p>
                {name} will not be able to create a new event, or publish one for the first
                time.
              </p>
              <p className="mt-3">
                <span className="font-medium text-fg">Nothing is deleted or cancelled.</span>{' '}
                They can still run every event they already host.
              </p>
              <p className="mt-3">
                Tickets on sale keep selling. Drafts are kept but cannot be published while
                this is off.
              </p>
              <p className="mt-3">
                Their network is untouched. You can switch this back on at any time.
              </p>
            </>
          )
        }
        confirmLabel={pending ? 'Allow event creation' : 'Stop new events'}
        tone={pending ? 'primary' : 'danger'}
        busy={busy}
        onConfirm={() => void apply()}
        onClose={() => setPending(null)}
      />
    </div>
  )
}

export default ConnectorEventPermission
