import type { Connector } from '../../lib/types'

/**
 * §7.3, as one module: when a connector's Stripe account may take money for a
 * ticket, and what is outstanding when it may not.
 *
 * It lives apart from the screens on purpose. The connector's own payment page
 * and the administrator's view of that connector both ask this question, and
 * two answers to "can they charge for this" is one answer too many. Plain
 * TypeScript with no JSX, so scripts/check-payout-state.mjs can import and run
 * it with no build step.
 */

/**
 * Mirrors the `connectors_stripe_status_known` check constraint.
 *
 * ponytail: declared here rather than in src/lib/types.ts because that file
 * belongs to the primary agent. `Connector` carries `stripe_account_id` only;
 * the other five columns exist in migration 20260916000002 and want to live on
 * `Connector` too. See the report — this interface disappears the day they do.
 */
export type StripeAccountStatus =
  | 'none'
  | 'pending'
  | 'ready'
  | 'restricted'
  | 'disconnected'

export interface ConnectorPayments extends Connector {
  stripe_connected_at: string | null
  stripe_charges_enabled: boolean
  stripe_payouts_enabled: boolean
  stripe_account_status: StripeAccountStatus
  stripe_checked_at: string | null
}

export interface PayoutState {
  /** Short enough for a badge beside the permission switch. */
  headline: string
  /** §7.3. Exactly what Stripe is still waiting for. Null when nothing is. */
  outstanding: string | null
  /** Whether *new* paid tickets may go on sale. Never gates existing bookings. */
  canSellPaid: boolean
  /** Which repair actually fixes it — so we never offer the wrong button. */
  fix: 'connect' | 'continue' | 'stripe' | null
}

/**
 * §7.3 as one function, so the connector's own screen and the admin's view of
 * it cannot disagree about whether an account can take money.
 *
 * `charges_enabled` is the only thing that decides it. `payouts_enabled` can
 * sit false for a week while Stripe verifies a bank account, and refusing to
 * sell tickets over that would be wrong: the money is safely in their balance
 * either way. It is worth saying out loud, though, so it is `outstanding`
 * rather than a blocker.
 */
export function payoutState(
  connector: Pick<
    ConnectorPayments,
    | 'stripe_account_id'
    | 'stripe_account_status'
    | 'stripe_charges_enabled'
    | 'stripe_payouts_enabled'
  >,
): PayoutState {
  const status = connector.stripe_account_status

  if (!connector.stripe_account_id || status === 'none') {
    return {
      headline: 'No Stripe account',
      outstanding:
        'No Stripe account is connected, so paid tickets cannot go on sale. Free events are unaffected.',
      canSellPaid: false,
      fix: 'connect',
    }
  }

  // §7.3, last row. The one that is easy to get wrong: losing the connection
  // stops new sales and nothing else. Everybody who already bought a ticket
  // keeps it, keeps the door, and keeps the right to a refund.
  if (status === 'disconnected') {
    return {
      headline: 'Disconnected',
      outstanding:
        'This Stripe account is no longer connected. New paid sales are stopped. Bookings already made, the tickets issued for them, check-in and refunds all carry on working.',
      canSellPaid: false,
      fix: 'connect',
    }
  }

  if (status === 'restricted') {
    return {
      headline: 'Restricted by Stripe',
      outstanding:
        'Stripe has restricted this account and will not accept new charges through it. Stripe says what it needs — usually identity or business details — in the account dashboard. New paid sales stay shut until it is resolved; existing bookings and refunds are unaffected.',
      canSellPaid: false,
      fix: 'stripe',
    }
  }

  if (status === 'pending') {
    return {
      headline: 'Onboarding unfinished',
      outstanding:
        'Stripe has the account but has not finished setting it up. Continue on Stripe and answer what it still asks for. Until then, free events only.',
      canSellPaid: false,
      fix: 'continue',
    }
  }

  if (!connector.stripe_charges_enabled) {
    return {
      headline: 'Charges not enabled',
      outstanding:
        'Stripe has not switched charges on for this account yet. That is usually a verification step still in progress on Stripe’s side. Free events can go ahead in the meantime.',
      canSellPaid: false,
      fix: 'stripe',
    }
  }

  return {
    headline: 'Ready',
    outstanding: connector.stripe_payouts_enabled
      ? null
      : 'Payments will be taken normally, but Stripe has not released payouts to a bank account yet. The money is safe in the Stripe balance, and paid tickets may go on sale today.',
    canSellPaid: true,
    fix: connector.stripe_payouts_enabled ? null : 'stripe',
  }
}

