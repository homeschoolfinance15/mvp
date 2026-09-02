import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!url || !key) {
  throw new Error(
    'Missing Supabase configuration. Copy .env.example to .env and fill in ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.',
  )
}

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
})

/**
 * Postgres raises exceptions with human-readable text on purpose (see the RPCs
 * in the migration), so surface that directly rather than a generic failure.
 */
export function errorMessage(error: unknown): string {
  if (!error) return 'Something went wrong.'
  if (typeof error === 'string') return error
  const e = error as { message?: string; error_description?: string }
  return e.message || e.error_description || 'Something went wrong.'
}
