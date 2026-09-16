import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthProvider'
import { signMedia } from '../lib/media'
import { supabase } from '../lib/supabase'
import { FEATURES } from '../lib/features'
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
      return `${who} applied to the waitlist`
    case 'event_registered':
      return `${who} has a place at your event`
    case 'event_updated':
      return 'An event you are going to has changed'
    case 'event_cancelled':
      return 'An event you were going to has been cancelled'
    case 'feedback_open':
      return 'You can now give feedback on an event you attended'
    case 'event_payments_blocked':
      return 'An event you host can no longer take payments'
  }

  // Exhaustive. A seventeenth kind fails the build here rather than arriving
  // in somebody's bell as "Something happened".
  //
  // That sentence used to be the default, and it was not hypothetical: four
  // kinds this platform writes today sat behind it, including the notice
  // telling an attendee their event had been cancelled. The writer was wired,
  // the reader was not, and nothing failed — a `default` returning plausible
  // prose is the construct that turns a missing case into a quiet lie.
  const unhandled: never = kind
  throw new Error(`Unhandled notification kind: ${String(unhandled)}`)
}

/** Where pressing it should take you. */
function destination(notification: Notification): string {
  switch (notification.kind) {
    // A switched-off feature has no page to open, so pressing the row just
    // marks it read rather than bouncing through a redirect.
    case 'mention':
    case 'comment':
    case 'like':
    case 'recommendations':
      return FEATURES.feed ? '/feed' : ''
    // Every one of these is about a specific event, and the notification row
    // carries its id — so send them to that event rather than to a list they
    // then have to search. A notification whose whole value is *which* event
    // is close to useless if pressing it lands you on all of them.
    // An invitation is the one of the three where /events/mine is certainly
    // empty: that tab lists `event_registrations`, and being invited creates an
    // `event_invites` row and no registration. The guest pressed a notification
    // that says somebody invited them to an event and arrived at a list with
    // nothing on it and no way to find out which event was meant — the precise
    // failure the paragraph above describes. The event's own page is where an
    // invitation can actually be accepted.
    case 'event_invited':
      return FEATURES.events && notification.event?.slug
        ? `/e/${notification.event.slug}`
        : FEATURES.events
          ? '/events'
          : ''
    // These two keep /events/mine: the person does hold a registration, and
    // what they need is their place and their ticket, not the public page.
    case 'event_updated':
    case 'event_cancelled':
      return FEATURES.events && notification.event_id
        ? `/events/mine`
        : FEATURES.events
          ? '/events'
          : ''
    // A host's notice. Theirs to act on, so it opens the event they run.
    case 'event_rsvp':
    case 'event_registered':
      return FEATURES.events && notification.event_id
        ? `/manage/events/${notification.event_id}/guests`
        : FEATURES.events
          ? '/events'
          : ''
    // FDB-03: the destination has to survive the sign-in that may follow it.
    case 'feedback_open':
      return FEATURES.events ? '/events/mine' : ''
    // BUY-14. Stripe tells the account holder they have been restricted; what
    // it cannot tell them is which of their events just stopped selling. That
    // is the whole value of this one, so it opens that event rather than a
    // payment settings page they may not even be able to reach — a cohost
    // holds no login for the account that broke.
    case 'event_payments_blocked':
      return FEATURES.events && notification.event_id
        ? `/manage/events/${notification.event_id}`
        : ''
    case 'circle_message':
      return '/circle'
    case 'waitlist_joined':
      // Vetting happens on the admin screen, where Assign lives.
      return '/admin'
    // Dealt with on your own dashboard, so pressing the row just marks it
    // read. Listed rather than defaulted, so that adding a kind is a compile
    // error and not a silent nowhere.
    case 'member_joined':
    case 'report_raised':
    case 'report_resolved':
      return ''
  }

  const unhandled: never = notification.kind
  throw new Error(`Unhandled notification kind: ${String(unhandled)}`)
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
        // The applicant has no profile to look up in the directory, so their
        // name comes off the waitlist row the notification points at. RLS
        // still applies to the embed: a non-admin gets null, not a name.
        .from('notifications')
        .select('*, waitlist_entries(full_name), event:events(slug)')
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
          // A pushed row carries only the columns of the table, so a waitlist
          // notice would arrive without the applicant's name. Cheaper to ask
          // for the page again than to fetch the one name separately.
          if (incoming.kind === 'waitlist_joined') {
            void load()
            return
          }
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
    // load is stable, but the waitlist branch calls it, so it belongs here.
  }, [profile, load])

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
                const name =
                  actor?.full_name ??
                  notification.waitlist_entries?.full_name ??
                  'Someone'
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
