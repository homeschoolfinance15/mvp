// Execute the real handler against local Supabase without depending on Docker's
// package downloads. Credentials are inherited only from the test runner.
const serve = Deno.serve.bind(Deno)
Deno.serve = ((handler: Deno.ServeHandler) => serve({ hostname: '127.0.0.1', port: 5487 }, handler)) as typeof Deno.serve
await import('../supabase/functions/event-email/index.ts')
