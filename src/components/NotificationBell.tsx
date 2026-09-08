import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthProvider'
import { signMedia } from '../lib/media'
import { supabase } from '../lib/supabase'
import type { DirectoryEntry, Notification, NotificationKind } from '../lib/types'
import { formatDate, Initials } from './ui'

/**
 * What happened while you were away.
 *
 * The row level security policy already limits these to their recipient, so
 * nothing here filters by person. Live inserts arrive over Realtime, because
 * a bell that only updates when you change page is a bell people learn to
 * ignore.
 *
 * ponytail: newest 30, no paging. A notification you have not read in thirty
 * is a notification you were never going to read.
 */
const PAGE = 30

/** One sentence each, addressed to the person being told. */
function sentence(kind: NotificationKind, who: string): string {
  switch (kind) {
    case 'mention':
      return `${who} tagged you`
    case 'comment':
      return `${who} replied to your post`
    case 'like':
      return `${who} liked your post`
    case 'event_invited':
      return `${who} invited you to an event`
    case 'event_rsvp':
      return `${who} is coming to your event`
    case 'circle_message':
      return `${who} said something in your circle`
    case 'member_joined':
      return `${who} joined on your invitation`
    case 'report_raised':
      return `${who} raised something about one of your members`
    case 'report_resolved':
      return 'What you raised has been dealt with'
    case 'recommendations':
      return 'New suggestions are waiting for you'
    case 'waitlist_joined':
      // The applicant has no account yet, so there is no name to use here.
      return 'Somebody new applied to the waitlist'
    default:
      return 'Something happened'
  }
}

/** Where pressing it should take you. */
function destination(notification: Notification): string {
  switch (notification.kind) {
    case 'mention':
    case 'comment':
    case 'like':
    case 'recommendations':
      return '/feed'
    case 'event_invited':
    case 'event_rsvp':
      return '/events'
    case 'circle_message':
      return '/circle'
    case 'waitlist_joined':
      // Vetting happens on the admin screen, where Assign lives.
      return '/admin'
    default:
      // Reports and new members are dealt with on your own dashboard.
      return ''
  }
}

export function NotificationBell() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [items, setItems] = useState<Notification[]>([])
  const [directory, setDirectory] = useState<Record<string, DirectoryEntry>>({})
  const [avatars, setAvatars] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const unread = items.filter((n) => !n.read_at).length

  const load = useCallback(async () => {
    const [notificationsRes, dirRes] = await Promise.all([
      supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(PAGE),
      supabase.from('member_directory').select('*'),
    ])

    // A bell that cannot load is not worth an error message.
    if (notificationsRes.error) {
      console.error('[amazing] notifications:', notificationsRes.error)
      return
    }

    setItems((notificationsRes.data as Notification[]) ?? [])
    const rows = (dirRes.data as DirectoryEntry[]) ?? []
    setDirectory(Object.fromEntries(rows.map((d) => [d.id, d])))

    const faces = rows.map((d) => d.avatar_path).filter((p): p is string => Boolean(p))
    if (faces.length) {
      try {
        setAvatars(await signMedia(faces))
      } catch {
        /* a face is not worth failing over */
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Live arrivals. The select policy decides what reaches us.
  useEffect(() => {
    if (!profile) return
    const channel = supabase
      .channel(`notifications:${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `profile_id=eq.${profile.id}`,
        },
        (payload) => {
          const incoming = payload.new as Notification
          setItems((current) =>
            current.some((n) => n.id === incoming.id)
              ? current
              : [incoming, ...current].slice(0, PAGE),
          )
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [profile])

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function clearAll() {
    setItems((current) => current.map((n) => ({ ...n, read_at: n.read_at ?? 'now' })))
    await supabase.rpc('mark_notifications_read')
  }

  function press(notification: Notification) {
    setOpen(false)

    if (!notification.read_at) {
      setItems((current) =>
        current.map((n) =>
          n.id === notification.id ? { ...n, read_at: new Date().toISOString() } : n,
        ),
      )
      void supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', notification.id)
    }

    const to = destination(notification)
    if (to) navigate(to)

    if (notification.post_id) {
      // The feed has to render before there is anything to scroll to.
      setTimeout(() => {
        document
          .getElementById(`post-${notification.post_id}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 700)
    }
  }

  return (
    <div ref={panelRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        className="relative flex h-10 w-10 items-center justify-center text-dim transition-colors hover:text-fg"
      >
        {/* A bell, drawn rather than imported. */}
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="h-5 w-5"
        >
          <path
            d="M18 8.4A6 6 0 1 0 6 8.4c0 4.2-1.8 5.4-1.8 5.4h15.6S18 12.6 18 8.4Z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M10.3 18.6a2 2 0 0 0 3.4 0" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        {unread > 0 && (
          <span className="absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[0.625rem] font-medium text-ink tabular-nums">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          // On a phone the panel is anchored to the viewport, not to the
          // bell: anchoring it to a button near the right edge pushed its
          // left edge past zero and clipped every name. Note that a negative
          // left offset adds no scrollWidth, so an overflow check does not
          // catch it — only looking does.
          className="fixed inset-x-3 top-14 z-40 flex max-h-[70vh] flex-col overflow-hidden rounded-sm border border-line bg-ink shadow-xl sm:absolute sm:inset-x-auto sm:top-auto sm:right-0 sm:mt-2 sm:w-88"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="eyebrow">Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={clearAll}
                className="text-xs text-dim transition-colors hover:text-fg"
              >
                Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-dim">Nothing yet.</p>
          ) : (
            <ul className="divide-y divide-line overflow-y-auto">
              {items.map((notification) => {
                const actor = notification.actor_id
                  ? directory[notification.actor_id]
                  : undefined
                const name = actor?.full_name ?? 'Someone'
                return (
                  <li key={notification.id}>
                    <button
                      type="button"
                      onClick={() => press(notification)}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-fg/[0.03] ${
                        notification.read_at ? '' : 'bg-gold-wash/50'
                      }`}
                    >
                      {actor ? (
                        <Initials
                          name={actor.full_name}
                          url={actor.avatar_path ? avatars[actor.avatar_path] : undefined}
                          role={actor.role}
                        />
                      ) : (
                        <span className="mt-1 h-9 w-9 shrink-0 rounded-full border border-line" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm leading-snug text-fg">
                          {sentence(notification.kind, name)}
                        </span>
                        <span className="mt-0.5 block text-xs text-dim">
                          {formatDate(notification.created_at)}
                        </span>
                      </span>
                      {!notification.read_at && (
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
