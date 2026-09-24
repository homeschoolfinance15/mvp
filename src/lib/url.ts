/**
 * A link as people type it — "linkedin.com/in/you" — made into one that works
 * as an href. The fields are plain text rather than type="url" because the
 * browser rejects anything without a scheme, which is how most people write
 * a LinkedIn address.
 */
export function toLink(raw: string): string | null {
  const value = raw.trim()
  if (!value || /\s/.test(value)) return null
  const link = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`
  // ACC-07. "my name is mona" is not a link: it needs a dotted host name.
  try {
    const { protocol, hostname } = new URL(link)
    return /^https?:$/.test(protocol) && /^[^.]+(\.[^.]+)+$/.test(hostname) ? link : null
  } catch {
    return null
  }
}

export const LINK_HINT = 'Enter a link, like linkedin.com/in/you.'

