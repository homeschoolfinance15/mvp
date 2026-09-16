// ============================================================================
// The signed `state` that stripe-connect sends round the OAuth loop
//
// Its own file for one reason: it is the only security-critical logic in the
// payments workstream that can be exercised without a Stripe key, and
// scripts/check-connect-state.ts exercises it. Logic that guards money and is
// never run until production is logic nobody has checked.
//
// The callback is a URL Stripe hands to a browser, so it is the one part of
// the flow an attacker gets to touch. Two things it must make impossible:
//
//   aiming    the connector id is inside the signed payload, so changing it
//             breaks the HMAC and the callback is refused before Stripe is
//             called. There is no unsigned copy of it anywhere in the flow.
//
//   replay    the payload names the profile it was issued to, and expires.
//             stripe-connect refuses a state whose profile is not the caller,
//             so a stolen state is worthless without that person's session.
//
// ponytail: HMAC-SHA256 keyed on the service-role key — already the most
// privileged secret this runtime holds, already never leaves it, one fewer
// secret to rotate. STRIPE_CONNECT_STATE_SECRET overrides it if the two ever
// need separate rotation schedules.
// ============================================================================

/** Long enough to read a Stripe onboarding page, short enough to be worthless if stolen. */
export const STATE_MINUTES = 10

export interface StateClaim {
  connector_id: string
  profile_id: string
}

interface SignedState extends StateClaim {
  /** Epoch seconds. A state past this is refused without reading anything else. */
  exp: number
  /** Makes two states issued in the same second different strings. */
  nonce: string
}

const encoder = new TextEncoder()

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

/** `<base64url payload>.<base64url hmac>` — short enough for a query string. */
export async function signState(claim: StateClaim, secret: string): Promise<string> {
  const payload: SignedState = {
    ...claim,
    exp: Math.floor(Date.now() / 1000) + STATE_MINUTES * 60,
    nonce: crypto.randomUUID(),
  }
  const body = b64url(encoder.encode(JSON.stringify(payload)))
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body))
  return `${body}.${b64url(new Uint8Array(mac))}`
}

/** Null for anything tampered with, expired, or signed with another key. Never throws. */
export async function verifyState(state: string, secret: string): Promise<StateClaim | null> {
  const [body, mac] = String(state ?? '').split('.')
  if (!body || !mac) return null
  try {
    // crypto.subtle.verify is constant-time, so a wrong signature leaks nothing
    // about how wrong it was.
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      unB64url(mac),
      encoder.encode(body),
    )
    if (!ok) return null
    const claim = JSON.parse(new TextDecoder().decode(unB64url(body))) as SignedState
    if (!claim?.connector_id || !claim?.profile_id) return null
    if (!(claim.exp > Math.floor(Date.now() / 1000))) return null
    return { connector_id: claim.connector_id, profile_id: claim.profile_id }
  } catch {
    return null
  }
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// `Uint8Array<ArrayBuffer>`, not plain `Uint8Array`: SubtleCrypto will only
// take a view onto a real ArrayBuffer, which is what Uint8Array.from builds.
function unB64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}
