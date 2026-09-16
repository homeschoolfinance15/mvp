/**
 * Where somebody was before they were asked to make an account.
 *
 * ACC-07. A person who started at an event, then had to sign up, fill in
 * onboarding and answer the questionnaire, has been through three screens that
 * had nothing to do with the thing they actually wanted. Dropping them on a
 * dashboard at the end of it asks them to find their way back on their own,
 * with the ticket they had already chosen forgotten.
 *
 * So `/signup` writes down where they came from and what the ticket cost when
 * they started, and the last step of required onboarding reads it back.
 *
 * `sessionStorage` rather than `localStorage`: this belongs to one tab and one
 * sitting. A resume left lying around until tomorrow would eventually send
 * somebody else, on the same machine, to a stranger's checkout.
 *
 * Read it with `takeSignupResume` from an event handler or an effect — never
 * during render. It clears as it reads, and React renders components more than
 * once on purpose.
 */

const KEY = 'amazing:signup-resume'

export interface SignupResume {
  /** Where to send them once the account is complete. */
  path: string
  /** The event they started from, so a message can name it. */
  eventTitle: string
  /**
   * EVT-04. What the chosen ticket cost when they began, in minor units, so
   * "the price changed while you were signing up" can be said with numbers
   * rather than as a vague warning. Null when they had picked nothing.
   */
  priceCents: number | null
  currency: string | null
  /** ORG-03A. What the event was doing when they began: open, sold_out, closed. */
  capacityState: string | null
  /** ISO. How long ago "while you were signing up" actually was. */
  at: string
}

export function rememberSignupResume(resume: SignupResume): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(resume))
  } catch {
    // Storage is unavailable in some private-browsing modes. Losing the
    // resume costs a redirect, so it must never cost the signup itself.
  }
}

/** Reads and clears. Returns null when nobody arrived from an event. */
export function takeSignupResume(): SignupResume | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    sessionStorage.removeItem(KEY)
    return JSON.parse(raw) as SignupResume
  } catch {
    return null
  }
}

export function clearSignupResume(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // As above.
  }
}
