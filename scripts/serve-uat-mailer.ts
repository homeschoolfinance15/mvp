// Local test adapter: execute the actual dispatcher, but capture provider requests.
// No request can reach Resend or any other external service.
const realFetch = globalThis.fetch.bind(globalThis)
const batches: unknown[] = []
let fail = false
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.href === 'https://api.resend.com/emails/batch') {
    batches.push({ failed: fail, payload: JSON.parse(String(init?.body)) })
    return Promise.resolve(new Response(JSON.stringify(fail ? { message: 'UAT provider failure' } : { data: [] }), { status: fail ? 503 : 200 }))
  }
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('External network forbidden in UAT mailer')
  return realFetch(input, init)
}) as typeof fetch
const serve = Deno.serve.bind(Deno)
Deno.serve = ((handler: Deno.ServeHandler) => serve({ hostname: '127.0.0.1', port: 5488 }, async (request, info) => {
  const url = new URL(request.url)
  if (url.pathname === '/_test') {
    if (request.method === 'POST') fail = Boolean((await request.json()).fail)
    return Response.json({ batches })
  }
  return handler(request, info)
})) as typeof Deno.serve
await import('../supabase/functions/event-mailer/index.ts')
