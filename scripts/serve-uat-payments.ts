// Run the actual payment handlers locally with all provider traffic confined
// to the Stripe simulator. This is not a substitute for Stripe test mode.
const handlers = new Map<string, Deno.ServeHandler>()
const realServe = Deno.serve.bind(Deno)
const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname === '127.0.0.1' && url.port === '54321' && url.pathname.startsWith('/functions/v1/')) {
    url.port = '5489'
    return realFetch(input instanceof Request ? new Request(url, input) : url, init)
  }
  return realFetch(input, init)
}) as typeof fetch
let current = ''
Deno.serve = ((handler: Deno.ServeHandler) => { handlers.set(current, handler); return {} }) as typeof Deno.serve
for (const name of ['stripe-checkout', 'stripe-webhook', 'stripe-connect', 'stripe-reconcile', 'event-refund', 'event-email', 'payments-status']) {
  current = name
  await import(`../supabase/functions/${name}/index.ts`)
}
let offline = false
realServe({ hostname: '127.0.0.1', port: 5489 }, async (request, info) => {
  const url = new URL(request.url)
  if (url.pathname === '/_test') {
    if (request.method === 'POST') {
      const body = await request.json()
      offline = Boolean(body.offline)
      Deno.env.set('PLATFORM_FEE_BPS', String(body.fee ?? 0))
      current = 'stripe-checkout'
      await import(`../supabase/functions/stripe-checkout/index.ts?uat-fee=${body.fee ?? 0}`)
    }
    return Response.json({ offline })
  }
  if (url.pathname.startsWith('/functions/v1/')) {
    if (offline) return Response.json({ error: 'UAT simulated outage' }, { status: 503 })
    const handler = handlers.get(url.pathname.split('/').at(-1)!)
    return handler ? handler(request, info) : Response.json({ error: 'No UAT handler' }, { status: 404 })
  }
  url.host = '127.0.0.1:54321'
  return fetch(new Request(url, request))
})
