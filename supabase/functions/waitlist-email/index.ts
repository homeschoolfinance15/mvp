// ============================================================================
// waitlist-email — the one message an applicant gets
//
// Somebody fills in the form on the public page and, until now, heard nothing
// at all. A mistyped address stayed invisible to them and to us. This sends a
// short acknowledgement and nothing else: no marketing, no schedule, and no
// promise about being let in.
//
// Why it is safe to call without a session:
//
//   The browser has no session when it calls this — the applicant has no
//   account. So the endpoint takes an address and refuses to do anything with
//   it unless there is a waitlist row for that address, written in the last
//   hour, that has not been acknowledged yet. Claiming the row and sending are
//   in that order, so a repeated call finds nothing left to claim. The worst a
//   stranger can do is re-send nothing.
//
// The Resend key never reaches the browser, which is the whole reason this is
// an edge function rather than four lines in Landing.tsx.
//
// Deploy:  supabase functions deploy waitlist-email --no-verify-jwt
// Secrets: supabase secrets set RESEND_API_KEY=re_...
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

const FROM = 'Amazing AI <noreply@goamazing.ai>'
const SUBJECT = 'We have your application'

/** Rows older than this are not "just submitted" and are left alone. */
const CLAIM_WINDOW_MS = 60 * 60 * 1000

Deno.serve(async (request: Request) => {
  // The public page is a different origin, so the browser asks first.
  if (request.method === 'OPTIONS') return json(null, 204)
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return json({ error: 'RESEND_API_KEY is not set.' }, 500)

  let email = ''
  try {
    const body = await request.json()
    email = String(body?.email ?? '').trim().toLowerCase()
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400)
  }
  if (!email) return json({ error: 'An email address is required.' }, 400)

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Claim first. The update is the lock: whoever sets ack_sent_at owns the
  // send, and a second caller gets no rows back and does nothing.
  const { data: claimed, error: claimError } = await db
    .from('waitlist_entries')
    .update({ ack_sent_at: new Date().toISOString() })
    .is('ack_sent_at', null)
    .eq('email', email)
    // Computed here, not in the filter: PostgREST compares against a literal
    // and would read a SQL expression as a string.
    .gte('created_at', new Date(Date.now() - CLAIM_WINDOW_MS).toISOString())
    .select('id, full_name, email')
    .maybeSingle()

  if (claimError) return json({ error: claimError.message }, 500)
  // Nothing to acknowledge: already sent, too old, or never applied. Not an
  // error, and deliberately says nothing about which of the three it was.
  if (!claimed) return json({ sent: false }, 200)

  const firstName = String(claimed.full_name ?? '').split(' ')[0] || 'there'

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: claimed.email,
      subject: SUBJECT,
      text: TEXT(firstName),
      html: HTML(firstName),
    }),
  })

  if (!response.ok) {
    // Hand the row back so a later attempt can try again, rather than leaving
    // somebody permanently marked as emailed when nothing was sent.
    await db.from('waitlist_entries').update({ ack_sent_at: null }).eq('id', claimed.id)
    return json({ error: `Resend refused it: ${await response.text()}` }, 502)
  }

  return json({ sent: true }, 200)
})

const TEXT = (name: string) => `Hello ${name},

We have your application to Amazing AI. Somebody reads every one of them, so
this is not an automated queue — it is a person deciding which room you would
actually belong in.

That takes a little time. When a place opens, your community connector will be
in touch directly.

Nothing is needed from you in the meantime.

— Amazing AI
https://goamazing.ai
`

const HTML = (name: string) => `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#faf9f7;font-family:Georgia,'Times New Roman',serif;color:#2f2f2c;">
    <table role="presentation" style="max-width:520px;margin:0 auto;border-collapse:collapse;">
      <tr><td style="padding-bottom:28px;">
        <span style="font-size:20px;font-weight:700;letter-spacing:-0.03em;text-transform:uppercase;">Amazing<span style="color:#b08d3f;">.</span></span>
      </td></tr>
      <tr><td style="font-size:15px;line-height:1.65;">
        <p style="margin:0 0 18px;">Hello ${name},</p>
        <p style="margin:0 0 18px;">
          We have your application to Amazing AI. Somebody reads every one of them, so this
          is not an automated queue &mdash; it is a person deciding which room you would
          actually belong in.
        </p>
        <p style="margin:0 0 18px;">
          That takes a little time. When a place opens, your community connector will be in
          touch directly.
        </p>
        <p style="margin:0 0 28px;">Nothing is needed from you in the meantime.</p>
        <p style="margin:0;color:#6f6f68;font-size:13px;">
          &mdash; Amazing AI<br />
          <a href="https://goamazing.ai" style="color:#b08d3f;">goamazing.ai</a>
        </p>
      </td></tr>
    </table>
  </body>
</html>
`

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // The public page calls this straight after the insert.
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, apikey',
    },
  })
}
