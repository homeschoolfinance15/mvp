// ============================================================================
// invite-email — sends an invitation code as a link somebody can click
//
// Until now a code was handed over by hand: the connector copied AMZ-XXXX-XXXX
// out of their dashboard and pasted it into a message themselves. This mails
// it, as a link that opens the join page with the code already filled in, so
// the person being invited types nothing.
//
// Who may send what, checked here and not in the browser:
//
//   A connector may send their own invitation codes. An admin may send those
//   and the claim codes that make somebody a connector. Everyone else is
//   refused, which is what keeps this from being an open relay for mail from
//   goamazing.ai. The caller's own token answers "who are you"; the service
//   role reads the code, so a stranger cannot use the refusals to work out
//   which codes exist.
//
// A code that is disabled, used up or already claimed is not sent: the link
// would land on "this code has already been used", which is a worse way to
// find out than being told here.
//
// Deploy:  supabase functions deploy invite-email
// Secrets: supabase secrets set RESEND_API_KEY=re_...
//          supabase secrets set SITE_URL=https://goamazing.ai   (optional)
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

const FROM = 'Amazing AI <noreply@goamazing.ai>'
const SITE = (Deno.env.get('SITE_URL') ?? 'https://goamazing.ai').replace(/\/+$/, '')

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return json(null, 204)
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return json({ error: 'RESEND_API_KEY is not set.' }, 500)

  const authorization = request.headers.get('Authorization') ?? ''
  if (!authorization) return json({ error: 'Sign in to send an invitation.' }, 401)

  let code = ''
  let email = ''
  try {
    const body = await request.json()
    code = String(body?.code ?? '').trim().toUpperCase()
    email = String(body?.email ?? '').trim().toLowerCase()
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400)
  }
  if (!code) return json({ error: 'A code is required.' }, 400)
  // Deliberately loose. The address is typed by the person sending it, the
  // mail provider is the real judge of what is deliverable, and a bounce is
  // recoverable; a clever pattern here only rejects real addresses.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'That does not look like an email address.' }, 400)
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!anonKey) return json({ error: 'SUPABASE_ANON_KEY is not set.' }, 500)

  // Two clients on purpose: the caller's token establishes who is asking, and
  // the service role reads the code itself. Reading the code as the caller
  // would leak, through the shape of the refusal, whether a code exists.
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
  })
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: userData } = await asCaller.auth.getUser()
  if (!userData?.user) return json({ error: 'Sign in to send an invitation.' }, 401)

  const [{ data: connectorId }, { data: isAdmin }] = await Promise.all([
    asCaller.rpc('my_connector_id'),
    asCaller.rpc('is_admin'),
  ])

  const REFUSED = { error: 'That code is not yours to send.' }

  const { data: invite } = await db
    .from('invite_codes')
    .select('code, status, max_uses, use_count, connector_id')
    .eq('code', code)
    .maybeSingle()

  let recipientName: string | null = null

  if (invite) {
    if (!isAdmin && invite.connector_id !== connectorId) return json(REFUSED, 403)
    if (invite.status !== 'active' || invite.use_count >= invite.max_uses) {
      return json({ error: 'That code is no longer active.' }, 409)
    }
  } else {
    // The other kind of code: an admin making somebody a connector.
    const { data: claim } = await db
      .from('connector_invitations')
      .select('claim_code, full_name, claimed_at')
      .eq('claim_code', code)
      .maybeSingle()

    if (!claim || !isAdmin) return json(REFUSED, 403)
    if (claim.claimed_at) return json({ error: 'That code has already been used.' }, 409)
    recipientName = claim.full_name
  }

  const firstName = String(recipientName ?? '').split(' ')[0] || null
  const link = `${SITE}/join?code=${encodeURIComponent(code)}`

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: email,
      subject: 'Your invitation to Amazing AI',
      text: TEXT(firstName, code, link),
      html: HTML(firstName, code, link),
    }),
  })

  if (!response.ok) {
    return json({ error: `Resend refused it: ${await response.text()}` }, 502)
  }

  return json({ sent: true }, 200)
})

const TEXT = (name: string | null, code: string, link: string) =>
  `${name ? `Hello ${name},` : 'Hello,'}

You have been invited to Amazing AI.

Open this link to set up your account. Your invitation code is already in it,
so there is nothing to type:

${link}

If the link does not work, go to ${SITE}/join and enter the code ${code}.

— Amazing AI
`

const HTML = (name: string | null, code: string, link: string) =>
  `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#faf9f7;font-family:Georgia,'Times New Roman',serif;color:#2f2f2c;">
    <table role="presentation" style="max-width:520px;margin:0 auto;border-collapse:collapse;">
      <tr><td style="padding-bottom:28px;">
        <span style="font-size:20px;font-weight:700;letter-spacing:-0.03em;text-transform:uppercase;">Amazing<span style="color:#b08d3f;">.</span></span>
      </td></tr>
      <tr><td style="font-size:15px;line-height:1.65;">
        <p style="margin:0 0 18px;">${name ? `Hello ${escapeHtml(name)},` : 'Hello,'}</p>
        <p style="margin:0 0 24px;">You have been invited to Amazing AI.</p>
        <p style="margin:0 0 24px;">
          <a href="${link}" style="display:inline-block;padding:12px 22px;background:#2f2f2c;color:#faf9f7;text-decoration:none;font-size:14px;">
            Set up your account
          </a>
        </p>
        <p style="margin:0 0 24px;">
          Your invitation code is already in that link, so there is nothing to type. If the
          button does not work, go to <a href="${SITE}/join" style="color:#b08d3f;">${SITE.replace(
            /^https?:\/\//,
            '',
          )}/join</a> and enter this code:
        </p>
        <p style="margin:0 0 28px;font-family:'Courier New',monospace;font-size:18px;letter-spacing:0.15em;color:#b08d3f;">${code}</p>
        <p style="margin:0;color:#6f6f68;font-size:13px;">&mdash; Amazing AI</p>
      </td></tr>
    </table>
  </body>
</html>
`

/** The one value here that nobody on our side wrote: a name an admin typed. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers':
        'authorization, x-client-info, apikey, content-type',
    },
  })
}
