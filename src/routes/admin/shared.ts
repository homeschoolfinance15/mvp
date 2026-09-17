import { supabase } from '../../lib/supabase'
import type { Profile } from '../../lib/types'
import type { ConnectorPayments } from '../connector/payouts'

/**
 * The rows more than one admin section needs, and the queries that fetch them.
 *
 * Each section loads its own data now, so the same three tables are read from
 * several files. They are spelled once here rather than copied — not for
 * elegance, but because one of these spellings is load-bearing and a copy of
 * it will rot.
 */

/**
 * `select('*, profiles(*)')` already brings back every Stripe column on the
 * connector row; `ConnectorPayments` is only the type saying so, until those
 * columns land on `Connector` itself in src/lib/types.ts.
 */
export interface ConnectorRow extends ConnectorPayments {
  profiles: Profile | null
}

export interface LinkRow {
  id: string
  created_at: string
  connector_id: string
  user_profile_id: string
  connectors: { profiles: { full_name: string } | null } | null
}

/**
 * `profiles!connectors_profile_id_fkey`, not `profiles`. The event platform
 * added `connectors.events_permission_changed_by` (ORG-01B, which admin last
 * moved the permission) as a second foreign key to profiles, and PostgREST
 * refuses an ambiguous embed rather than guessing: "more than one
 * relationship was found". The whole Connectors tab came back empty with that
 * sentence above it.
 *
 * Every embed of profiles *through* connectors has to name the constraint,
 * which is why both queries below live here instead of in the four sections
 * that call them.
 */
export function loadConnectors() {
  return supabase
    .from('connectors')
    .select('*, profiles!connectors_profile_id_fkey(*)')
    .order('created_at', { ascending: false })
}

/** Who each connector brought in. Same constraint-naming rule as above. */
export function loadLinks() {
  return supabase
    .from('connector_user_links')
    .select(
      'id, created_at, connector_id, user_profile_id, connectors(profiles!connectors_profile_id_fkey(full_name))',
    )
}

/**
 * Every profile, keyed by id. Several sections show a name for an id they
 * hold — a note's subject, an event's host, who changed a permission — and
 * the directory is small enough that one read is cheaper than a join per row.
 */
export function loadProfiles() {
  return supabase.from('profiles').select('*').order('created_at', { ascending: false })
}

export function byId(profiles: Profile[]): Record<string, Profile> {
  return Object.fromEntries(profiles.map((p) => [p.id, p]))
}
