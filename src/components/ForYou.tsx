import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MemberCard } from './MemberCard'
import { EmptyState, Initials, Panel, SectionHeader } from './ui'
import { useAuth } from '../context/AuthProvider'
import { signMedia } from '../lib/media'
import { errorMessage, supabase } from '../lib/supabase'
import type { DirectoryEntry, Event, Recommendation } from '../lib/types'
import { FEATURES } from '../lib/features'

/**
 * What the recommender thinks this member should look at, and why.
 *
 * Acting on one stamps acted_at, which is the whole feedback loop: the next
 * scheduled run is handed what landed and what didn't, and moves towards the
 * former. Nothing is trained — the improvement is measurable in
 * recommendation_performance or it isn't happening.
 *
 * The row level security policy already limits these to their subject, so
 * this component does no filtering of its own.
 */
export function ForYou() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [items, setItems] = useState<Recommendation[]>([])
  const [directory, setDirectory] = useState<Record<string, DirectoryEntry>>({})
  const [events, setEvents] = useState<Record<string, Event>>({})
  const [viewing, setViewing] = useState<DirectoryEntry | null>(null)
  const [error, setError] = useState('')
  const [avatars, setAvatars] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from('recommendations')
      .select('*')
      .is('acted_at', null)
      .order('created_at', { ascending: false })
      .order('rank', { ascending: true })
      .limit(6)

    if (fetchError) {
      setError(errorMessage(fetchError))
      return
    }

    const rows = (data as Recommendation[]) ?? []
    setItems(rows)
    if (rows.length === 0) return

    const [dirRes, eventsRes] = await Promise.all([
      supabase.from('member_directory').select('*'),
      supabase.from('events').select('*'),
    ])
    const directoryRows = (dirRes.data as DirectoryEntry[]) ?? []
    setDirectory(Object.fromEntries(directoryRows.map((d) => [d.id, d])))
    const faces = directoryRows.map((d) => d.avatar_path).filter((p): p is string => Boolean(p))
    if (faces.length) {
      try { setAvatars(await signMedia(faces)) } catch { /* a face is not worth failing over */ }
    }
    setEvents(Object.fromEntries(((eventsRes.data as Event[]) ?? []).map((e) => [e.id, e])))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** The signal. Drop it from view immediately; the write can trail. */
  function act(item: Recommendation) {
    setItems((current) => current.filter((i) => i.id !== item.id))
    void supabase
      .from('recommendations')
      .update({ acted_at: new Date().toISOString() })
      .eq('id', item.id)

    if (item.member_id) {
      const who = directory[item.member_id]
      if (who) setViewing(who)
    } else if (item.event_id && FEATURES.events) {
      navigate('/events')
    } else if (item.post_id) {
      document.getElementById(`post-${item.post_id}`)?.scrollIntoView({ behavior: 'smooth' })
    }
  }

  if (error || (items.length === 0 && !viewing)) return null

  return (
    <section className="mb-10">
      <SectionHeader
        title="For you"
        caption={`Picked out for you, ${profile?.full_name.split(' ')[0] ?? 'friend'}, with the reason why.`}
      />

      {items.length === 0 ? (
        <EmptyState>Nothing new to suggest yet.</EmptyState>
      ) : (
        <Panel className="divide-y divide-line">
          {items.map((item) => {
            const who = item.member_id ? directory[item.member_id] : undefined
            const event = item.event_id ? events[item.event_id] : undefined
            const label = who?.full_name ?? event?.title ?? 'A post worth reading'

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => act(item)}
                className="flex w-full items-start gap-3 px-5 py-4 text-left transition-colors hover:bg-fg/[0.02]"
              >
                {who ? (
                  <Initials
                    name={who.full_name}
                    url={who.avatar_path ? avatars[who.avatar_path] : undefined}
                    role={who.role}
                  />
                ) : (
                  <span className="mt-0.5 shrink-0 text-xs tracking-[0.1em] text-gold uppercase">
                    {event ? 'Event' : 'Post'}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{label}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    {item.reason}
                  </span>
                </span>
              </button>
            )
          })}
        </Panel>
      )}

      {viewing && <MemberCard member={viewing} onClose={() => setViewing(null)} />}
    </section>
  )
}
