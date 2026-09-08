/**
 * City lookup for the "Where are you based?" question.
 *
 * The handoff asks for "City search + fallback ... city, region and country.
 * Allow manual entry if lookup fails. No street address."
 *
 * Photon is the source: an open geocoder over OpenStreetMap data, built for
 * autocomplete, free, and needing no API key. That last part matters more
 * than it sounds. A keyed provider would mean either shipping a key in the
 * browser, which this project refuses to do anywhere else, or proxying every
 * keystroke through an edge function.
 *
 * Two things are deliberate:
 *
 *   Only city-level layers are requested, so a street address cannot come
 *   back even if somebody types one.
 *
 *   Lookup never blocks the answer. Whatever is typed stands on its own, and
 *   a failed or empty search leaves a perfectly good manual entry. Somebody
 *   in a village Photon has never heard of should not be stuck at signup.
 *
 * Privacy note: what somebody types here reaches Photon, which makes it a
 * subprocessor. It is recorded as one in COMPLIANCE.md. Self-hosting Photon
 * removes that, and the only thing that would change here is the URL.
 */

const ENDPOINT = 'https://photon.komoot.io/api'

export interface CityHit {
  /** "Manchester, England, United Kingdom" — what gets stored. */
  label: string
  name: string
  region: string | null
  country: string | null
}

/** Nothing useful comes back from one letter. */
export const MIN_QUERY = 2

function toHit(feature: {
  properties?: Record<string, unknown>
}): CityHit | null {
  const p = feature.properties ?? {}
  const name = typeof p.name === 'string' ? p.name : null
  if (!name) return null

  // state, then county, so "Manchester, England" beats "Manchester, Greater
  // Manchester" where both exist.
  const region =
    (typeof p.state === 'string' && p.state) ||
    (typeof p.county === 'string' && p.county) ||
    null
  const country = typeof p.country === 'string' ? p.country : null

  return {
    name,
    region,
    country,
    label: [name, region, country].filter(Boolean).join(', '),
  }
}

/**
 * Searches for a place. Returns an empty list rather than throwing: a
 * geocoder being down is not a reason a person cannot finish signing up.
 *
 * Pass an AbortSignal so a keystroke can cancel the request before it.
 */
export async function searchCities(
  query: string,
  signal?: AbortSignal,
): Promise<CityHit[]> {
  const q = query.trim()
  if (q.length < MIN_QUERY) return []

  const url = new URL(ENDPOINT)
  url.searchParams.set('q', q)
  url.searchParams.set('limit', '6')
  // City-level only. No street, no house number.
  for (const layer of ['city', 'district', 'state', 'country']) {
    url.searchParams.append('layer', layer)
  }

  try {
    const response = await fetch(url, { signal })
    if (!response.ok) return []
    const body = (await response.json()) as { features?: unknown[] }

    const seen = new Set<string>()
    const hits: CityHit[] = []
    for (const feature of body.features ?? []) {
      const hit = toHit(feature as { properties?: Record<string, unknown> })
      // The same city arrives twice when it is both a boundary and a place.
      if (hit && !seen.has(hit.label)) {
        seen.add(hit.label)
        hits.push(hit)
      }
    }
    return hits
  } catch {
    // Aborted, offline, or the service is having a day. Manual entry stands.
    return []
  }
}
