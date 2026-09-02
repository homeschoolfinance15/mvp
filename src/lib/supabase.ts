import { createClient } from '@supabase/supabase-js'

/**
 * These defaults are committed on purpose.
 *
 * The publishable key is designed to be exposed in browser code — it is already
 * inlined into the JS bundle of every build that has ever shipped, and row level
 * security is what actually protects the data, not the secrecy of this string.
 *
 * Committing them means a build succeeds from anywhere: GitHub Actions, a host's
 * own build step, or a laptop. Depending on build-time secrets is what left the
 * first production deploy rendering a blank page — Vite inlines VITE_* at build
 * time, so a missing variable is baked in permanently rather than being
 * recoverable at runtime.
 *
 * Environment variables still win when present, so a staging or fork deployment
 * can point somewhere else without touching this file.
 */
const DEFAULT_URL = 'https://lugpsuqcrwkokiyhbjmm.supabase.co'
const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_bqdEKUhnBuelmNJXIgXLrQ_rIupw4LN'

const url = import.meta.env.VITE_SUPABASE_URL || DEFAULT_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || DEFAULT_PUBLISHABLE_KEY

/**
 * Surfaced by the app as a readable screen rather than thrown at module scope.
 * A throw here runs before React mounts, which produces an empty page with the
 * reason visible only in the console.
 */
export const configError: string | null =
  url && key ? null : 'Supabase URL or publishable key is missing from this build.'

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
