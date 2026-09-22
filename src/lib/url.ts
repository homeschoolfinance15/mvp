/**
 * A link as people type it — "linkedin.com/in/you" — made into one that works
 * as an href. The fields are plain text rather than type="url" because the
 * browser rejects anything without a scheme, which is how most people write
 * a LinkedIn address.
 */
export function toLink(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`
}
