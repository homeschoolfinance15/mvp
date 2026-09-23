import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useLive } from './live'
import { supabase } from './supabase'

/**
 * The admin sections as plain links, with no page components attached, so the
 * sidebar (AppShell) can list them on every page without importing the admin
 * screens. AdminLayout adds the elements and turns them into routes.
 */

/** The counts the sidebar badges put on screen. */
export interface AdminCounts {
  connectors: number | null
  members: number | null
  events: number | null
  notes: number | null
  waitlist: number | null
}

export interface AdminLink {
  /** Absolute, so the sidebar and the router read the same string. */
  to: string
  label: string
  /** Sidebar heading this sits under. Sections with the same group stay together. */
  group: string
  /** Which live count to show beside the label, if any. */
  badge?: keyof AdminCounts
}

/** Every screen under /admin, in sidebar order. */
export const ADMIN_LINKS: AdminLink[] = [
  // Who can let people in, who is in, and who is asking.
  { to: '/admin/connectors', label: 'Connectors', group: 'People', badge: 'connectors' },
  { to: '/admin/members', label: 'Members', group: 'People', badge: 'members' },
  { to: '/admin/waitlist', label: 'Waitlist', group: 'People', badge: 'waitlist' },

  // What members are doing to and about each other.
  { to: '/admin/circles', label: 'Circles', group: 'Network' },
  { to: '/admin/notes', label: 'Notes', group: 'Network', badge: 'notes' },
  { to: '/admin/raised', label: 'Raised', group: 'Network' },

  // ORG-14. The platform's own records.
  { to: '/admin/events', label: 'Events', group: 'Platform', badge: 'events' },
  { to: '/admin/payments', label: 'Payments', group: 'Platform' },
  { to: '/admin/log', label: 'Log', group: 'Platform' },
]

const NO_COUNTS: AdminCounts = {
  connectors: null,
  members: null,
  events: null,
  notes: null,
  waitlist: null,
}

/**
 * Five `head: true` counts — no rows cross the wire, only the numbers. AppShell
 * calls this on every page; `enabled` false (anybody but an administrator)
 * runs no query and subscribes to nothing.
 */
export function useAdminCounts(enabled: boolean): AdminCounts {
  const [counts, setCounts] = useState<AdminCounts>(NO_COUNTS)
  const { pathname } = useLocation()

  const load = useCallback(async () => {
    if (!enabled) return
    const head = { count: 'exact' as const, head: true }
    const [connectors, members, events, notes, waitlist] = await Promise.all([
      supabase.from('connectors').select('id', head),
      // Event-only accounts are listed apart on the Members page (ADM-10).
      supabase.from('profiles').select('id', head).eq('role', 'user').eq('network_member', true),
      supabase.from('events').select('id', head),
      supabase.from('connector_notes').select('id', head),
      // Only people still waiting on a decision (ADM-14): turned down and
      // already handed a code are both decided.
      supabase
        .from('waitlist_entries')
        .select('id', head)
        .is('declined_at', null)
        .is('assigned_at', null),
    ])

    // A failed count shows nothing rather than a wrong zero.
    setCounts({
      connectors: connectors.count,
      members: members.count,
      events: events.count,
      notes: notes.count,
      waitlist: waitlist.count,
    })
  }, [enabled])

  useEffect(() => {
    void load()
  }, [load, pathname])

  // Live, so approving somebody updates the badge beside the page you are on.
  useLive(
    ['connectors', 'profiles', 'events', 'connector_notes', 'waitlist_entries'],
    load,
    { enabled },
  )

  return counts
}
