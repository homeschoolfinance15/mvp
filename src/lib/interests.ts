/**
 * Interests are the cold-start signal for matching: what somebody says they
 * care about, before the network has watched them do anything.
 *
 * Kept as a plain text[] rather than a tags table. There is no tag to rename,
 * merge or count yet, and normalising to lowercase here means "Climate" and
 * "climate" are already the same thing to a query.
 */

export const MAX_INTERESTS = 12
export const MAX_INTEREST_LENGTH = 40

export const INTERESTS_PLACEHOLDER = 'founder, climate, design (separate with commas)'

/** "Founder, climate, Climate " -> ['founder','climate'] */
export function parseInterests(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const tag = part.trim().toLowerCase().slice(0, MAX_INTEREST_LENGTH)
    if (tag) seen.add(tag)
  }
  return [...seen].slice(0, MAX_INTERESTS)
}

export function formatInterests(interests: string[] | null | undefined): string {
  return (interests ?? []).join(', ')
}
