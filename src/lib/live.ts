import { useEffect, useId, useRef } from 'react'
import { supabase } from './supabase'

/**
 * Tell me when this table changed, so a screen can stop being stale.
 *
 * Every list in this product used to be a photograph taken when the page
 * loaded. A host watching registrations arrive saw nothing until they
 * refreshed; two stewards on a door could not see each other's scans; the
 * administrator's sidebar said "Waitlist 35" for as long as you stayed on the
 * page, however many people you had just let in. The circle chat and the
 * notification bell already subscribed to Postgres changes, so the mechanism
 * was in the stack and simply had not been taken anywhere else.
 *
 * **It signals staleness; it never delivers data.** The subscription payload
 * carries the columns of one table and nothing joined onto it — the bell
 * learned this when a pushed notification arrived without the applicant's
 * name — so trusting it would mean half-populated rows appearing on screen.
 * Instead a change of any kind calls the page's own loader, which goes through
 * the same query and the same row-level policies it always did. Nothing
 * reaches a screen that its reader could not already have fetched.
 *
 * **It must never be pointed at a screen holding unsaved work.** Re-running a
 * loader replaces what is on screen, and a form rebuilt underneath somebody
 * mid-sentence is lost work, which QLT-03 forbids in as many words. Lists,
 * counts and read-only records are what this is for. An editor keeps its own
 * state and should be told a thing changed, not have the change applied to it.
 *
 * ponytail: one hook, a debounce and a channel. No cache, no store, no
 * reconciliation layer — the loaders already exist and already work.
 */
export function useLive(
  tables: string[],
  onChange: () => void,
  options?: { enabled?: boolean; filter?: string },
): void {
  const enabled = options?.enabled ?? true
  const filter = options?.filter

  // The callback changes identity on most renders. Held in a ref so that does
  // not tear the subscription down and build it again on every keystroke
  // elsewhere on the page.
  const latest = useRef(onChange)
  latest.current = onChange

  // Supabase throws when two channels share a name, which is how the bell
  // ended up rendered once instead of twice. `useId` is unique per component
  // instance, so two lists watching the same table cannot collide.
  const id = useId()

  // Stable across renders unless the tables genuinely change: a new array
  // literal every render would resubscribe every render.
  const key = tables.join(',')

  useEffect(() => {
    if (!enabled || !key) return

    let timer: number | undefined
    // A bulk write — an organiser importing, a sweep confirming twenty orders —
    // arrives as a burst. Coalesced into one reload, trailing edge, so the
    // screen settles on the finished state rather than flickering through it.
    const nudge = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => latest.current(), 400)
    }

    const channel = supabase.channel(`live:${id}:${key}`)
    for (const table of key.split(',')) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
        nudge,
      )
    }
    channel.subscribe()

    return () => {
      window.clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [enabled, key, filter, id])
}
