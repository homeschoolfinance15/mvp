/**
 * The password rule, in one place.
 *
 * These have to match `minimum_password_length` and `password_requirements`
 * in supabase/config.toml. The server is the one that actually enforces them;
 * checking here only exists so somebody is told what is wrong before the
 * round trip, rather than being handed a rejection they have to decode.
 */

export const MIN_PASSWORD_LENGTH = 12

export const PASSWORD_RULE =
  'At least 12 characters, with an upper and a lower case letter, a number and a symbol.'

/** The first thing wrong with it, or null when it will be accepted. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (!/[a-z]/.test(password)) return 'Include a lower case letter.'
  if (!/[A-Z]/.test(password)) return 'Include an upper case letter.'
  if (!/[0-9]/.test(password)) return 'Include a number.'
  if (!/[^A-Za-z0-9]/.test(password)) return 'Include a symbol.'
  return null
}
