import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DashboardShell, type Tab } from '../../components/DashboardShell'
import { MemberCard } from '../../components/MemberCard'
import { PostFeed } from '../../components/PostFeed'
import {
  Button,
  ConfirmModal,
  EmptyState,
  Field,
  formatDateTime,
  Initials,
  Input,
  LoadFailed,
  Modal,
  Notice,
  Panel,
  SectionHeader,
  Select,
  Spinner,
  Textarea,
} from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import { FEATURES } from '../../lib/features'
import { ACCEPT_ATTR, signMedia, uploadMedia } from '../../lib/media'
import { errorMessage, functionError, loadFailed, supabase } from '../../lib/supabase'
import type {
  DirectoryEntry,
  Event,
  EventHost,
  EventInvitation,
  RsvpStatus,
} from '../../lib/types'

/** What event-email will send. */
type MailKind = 'invited' | 'cohost' | 'updated' | 'cancelled' | 'rsvp'

/**
 * Mail, sent once the change is already in the database.
 *
 * Never blocking and never undoing: an event that was correctly created,
 * edited or cancelled is not thrown away because Resend was having a bad
 * afternoon. The caller decides whether the failure is worth showing.
 *
 * ponytail: fired from the browser, like every other mail in this codebase,
 * so a tab closed mid-send drops the message. Move it behind a database
 * trigger if that ever costs more than the four lines it saves here.
 */
async function sendEventEmail(
  kind: MailKind,
  eventId: string,
  profileId?: string,
): Promise<string> {
  const { error } = await supabase.functions.invoke('event-email', {
    body: { kind, event_id: eventId, profile_id: profileId },
  })
  return error ? await functionError(error) : ''
}

/** "Elena", "Elena and James", "Elena, James and Priya". */
function names(list: string[]): string {
  if (list.length === 0) return 'someone'
  if (list.length === 1) return list[0]
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/**
 * Luma semantics inside a private network: everyone on the platform sees
 * every event and anyone may RSVP. A host's invitation is a nudge, not a
 * gate — discovery has to be open or nothing gets discovered. The front door
 * is the gate, and the waitlist never gets through it.
 *
 * Hosting is narrower: connectors and admins, enforced by can_host_events().
 * An event can have several of them — events.host_id is whoever created it,
 * event_hosts is everybody else, and hosts_event() is what the database
 * actually asks. Here that arrives as one list of ids per event.
 */
export default function Events() {
  const { profile } = useAuth()

  const [tab, setTab] = useState('upcoming')
  const [events, setEvents] = useState<Event[]>([])
  const [invitations, setInvitations] = useState<EventInvitation[]>([])
  const [coHosts, setCoHosts] = useState<EventHost[]>([])
  const [directory, setDirectory] = useState<Record<string, DirectoryEntry>>({})
  const [covers, setCovers] = useState<Record<string, string>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState('')

  const canHost = profile?.role === 'admin' || profile?.role === 'connector'

  const load = useCallback(async () => {
    setError('')
    setFailed(false)
    const [eventsRes, invitesRes, hostsRes, dirRes] = await Promise.all([
      supabase.from('events').select('*').order('starts_at', { ascending: true }),
      supabase.from('event_invitations').select('*'),
      supabase.from('event_hosts').select('*'),
      supabase.from('member_directory').select('*'),
    ])

    const firstError = [
      eventsRes.error,
      invitesRes.error,
      hostsRes.error,
      dirRes.error,
    ].find(Boolean)
    if (firstError) {
      loadFailed(firstError, 'events')
      setFailed(true)
      setLoading(false)
      return
    }

    const rows = (eventsRes.data as Event[]) ?? []
    setEvents(rows)
    setInvitations((invitesRes.data as EventInvitation[]) ?? [])
    setCoHosts((hostsRes.data as EventHost[]) ?? [])
    setDirectory(
      Object.fromEntries(((dirRes.data as DirectoryEntry[]) ?? []).map((d) => [d.id, d])),
    )

    // Event covers and every member's picture, signed together.
    const directoryRows = (dirRes.data as DirectoryEntry[]) ?? []
    const paths = [
      ...rows.map((e) => e.cover_path),
      ...directoryRows.map((d) => d.avatar_path),
    ].filter((p): p is string => Boolean(p))
    if (paths.length) {
      try {
        setCovers(await signMedia(paths))
      } catch {
        setCovers({})
      }
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Every link in an event email points at one event. Open it, on whichever
  // tab it belongs to, then take the id back out of the address so a later
  // click on the list is not fighting it.
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    const wanted = params.get('event')
    if (!wanted || events.length === 0) return
    const found = events.find((e) => e.id === wanted)
    if (found) {
      const over = new Date(found.ends_at ?? found.starts_at).getTime() < Date.now()
      setTab(over ? 'past' : 'upcoming')
      setSelectedId(found.id)
    }
    setParams({}, { replace: true })
  }, [events, params, setParams])

  /** Creator plus co-hosts, which is what hosts_event() answers in the database. */
  const hostIdsFor = useCallback(
    (event: Event) => [
      ...new Set([
        event.host_id,
        ...coHosts.filter((h) => h.event_id === event.id).map((h) => h.profile_id),
      ]),
    ],
    [coHosts],
  )

  /**
   * Reload, and surface anything the write wanted to say on the way back.
   * The notice is set after the load, which clears it — the other way round
   * and it would be wiped before anybody read it.
   */
  const reload = useCallback(
    async (notice?: string) => {
      await load()
      if (notice) setError(notice)
    },
    [load],
  )

  const now = Date.now()
  const upcoming = useMemo(
    () => events.filter((e) => new Date(e.ends_at ?? e.starts_at).getTime() >= now),
    [events, now],
  )
  const past = useMemo(
    () => [...events.filter((e) => new Date(e.ends_at ?? e.starts_at).getTime() < now)].reverse(),
    [events, now],
  )

  // Below lg the detail sits under the list, off the bottom of the screen.
  // Selecting something has to take you to it.
  function revealDetail() {
    if (window.innerWidth >= 1024) return
    requestAnimationFrame(() =>
      document.getElementById('event-detail')?.scrollIntoView({ behavior: 'smooth' }),
    )
  }

  const shown = tab === 'upcoming' ? upcoming : past
  const selected = events.find((e) => e.id === selectedId) ?? null

  const tabs: Tab[] = [
    { id: 'upcoming', label: 'Upcoming', count: upcoming.length },
    { id: 'past', label: 'Past', count: past.length },
  ]

  return (
    <DashboardShell
      title="Events"
      caption="Where the network actually meets. Anyone here can come; connectors and administrators put them on."
      tabs={tabs}
      activeTab={tab}
      onTabChange={(id) => {
        setTab(id)
        setSelectedId(null)
      }}
    >
      {loading ? (
        <div className="flex justify-center py-16 text-dim">
          <Spinner />
        </div>
      ) : failed ? (
        <LoadFailed what="events" onRetry={load} />
      ) : (
        <>
          {error && (
            <div className="mb-6">
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          <SectionHeader
            title={tab === 'upcoming' ? 'Coming up' : 'Already happened'}
            action={
              canHost ? (
                <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                  Create event
                </Button>
              ) : undefined
            }
          />

          <div className="grid gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
            <section>
              {shown.length === 0 ? (
                <EmptyState>
                  {tab === 'upcoming' ? 'Nothing on the calendar yet.' : 'Nothing has happened yet.'}
                </EmptyState>
              ) : (
                <Panel className="divide-y divide-line">
                  {shown.map((event) => {
                    const going = invitations.filter(
                      (i) => i.event_id === event.id && i.status === 'going',
                    ).length
                    return (
                      <button
                        key={event.id}
                        type="button"
                        onClick={() => {
                          setSelectedId(event.id)
                          revealDetail()
                        }}
                        className={`block w-full px-5 py-4 text-left transition-colors ${
                          event.id === selectedId ? 'bg-gold-wash' : 'hover:bg-fg/[0.02]'
                        }`}
                      >
                        <div className="truncate text-sm font-medium text-fg">{event.title}</div>
                        <div className="mt-1 truncate text-xs text-dim">
                          {formatDateTime(event.starts_at)}
                          {event.location ? ` · ${event.location}` : ''}
                        </div>
                        <div className="mt-1 text-xs text-muted tabular-nums">
                          {going} going
                        </div>
                      </button>
                    )
                  })}
                </Panel>
              )}
            </section>

            <section id="event-detail" className="scroll-mt-20">
              {selected ? (
                <EventDetail
                  key={selected.id}
                  event={selected}
                  coverUrl={selected.cover_path ? covers[selected.cover_path] : undefined}
                  invitations={invitations.filter((i) => i.event_id === selected.id)}
                  hostIds={hostIdsFor(selected)}
                  directory={directory}
                  avatars={covers}
                  onChanged={reload}
                />
              ) : (
                <div className="hidden lg:block">
                  <EmptyState>Select an event to see it.</EmptyState>
                </div>
              )}
            </section>
          </div>

          {creating && (
            <EventFormModal
              directory={directory}
              onClose={() => setCreating(false)}
              onSaved={async (notice) => {
                setCreating(false)
                await reload(notice)
              }}
            />
          )}
        </>
      )}
    </DashboardShell>
  )
}

/* -------------------------------------------------------------------------- */
/* One event                                                                   */
/* -------------------------------------------------------------------------- */

function EventDetail({
  event,
  coverUrl,
  invitations,
  hostIds,
  directory,
  avatars,
  onChanged,
}: {
  event: Event
  coverUrl?: string
  invitations: EventInvitation[]
  /** Creator plus co-hosts. */
  hostIds: string[]
  directory: Record<string, DirectoryEntry>
  /** Covers and faces share one signed-URL map — see the load above. */
  avatars: Record<string, string>
  onChanged: (notice?: string) => Promise<void>
}) {
  const { profile } = useAuth()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [inviteId, setInviteId] = useState('')
  const [viewing, setViewing] = useState<DirectoryEntry | null>(null)
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const mine = invitations.find((i) => i.profile_id === profile?.id)
  const going = invitations.filter((i) => i.status === 'going')
  const isHost = hostIds.includes(profile?.id ?? '') || profile?.role === 'admin'
  const hostNames = hostIds
    .map((id) => directory[id]?.full_name)
    .filter((name): name is string => Boolean(name))

  /** The composite primary key makes a second answer an update, not a row. */
  async function rsvp(status: RsvpStatus) {
    if (!profile) return
    setBusy(true)
    setError('')
    const { error: upsertError } = await supabase.from('event_invitations').upsert(
      {
        event_id: event.id,
        profile_id: profile.id,
        status,
        responded_at: new Date().toISOString(),
      },
      { onConflict: 'event_id,profile_id' },
    )
    setBusy(false)
    if (upsertError) {
      setError(errorMessage(upsertError))
      return
    }
    // The hosts hear about a yes. Whether that mail lands is their problem
    // and not this guest's, so it is not waited on and not reported here.
    if (status === 'going') void sendEventEmail('rsvp', event.id)
    await onChanged()
  }

  async function invite(e: FormEvent) {
    e.preventDefault()
    if (!inviteId) return
    setBusy(true)
    setError('')
    const { error: insertError } = await supabase
      .from('event_invitations')
      .insert({ event_id: event.id, profile_id: inviteId, status: 'invited' })
    if (insertError) {
      setBusy(false)
      setError(
        insertError.code === '23505'
          ? 'They are already on the list.'
          : errorMessage(insertError),
      )
      return
    }
    const mailError = await sendEventEmail('invited', event.id, inviteId)
    setBusy(false)
    setInviteId('')
    await onChanged(
      mailError ? `They are on the list, but the email did not send: ${mailError}` : undefined,
    )
  }

  async function remove() {
    setConfirmingDelete(false)
    setBusy(true)
    // Before the delete, not after: the guest list is what the mail is
    // addressed to, and it cascades away with the event.
    const mailError = await sendEventEmail('cancelled', event.id)
    const { error: deleteError } = await supabase.from('events').delete().eq('id', event.id)
    setBusy(false)
    if (deleteError) {
      setError(errorMessage(deleteError))
      return
    }
    await onChanged(
      mailError ? `The event is cancelled, but nobody was emailed: ${mailError}` : undefined,
    )
  }

  // Hosts are not guests: inviting somebody to the thing they are running
  // reads as a mistake, and the email would tell them their own news.
  const notInvited = Object.values(directory).filter(
    (d) => !hostIds.includes(d.id) && !invitations.some((i) => i.profile_id === d.id),
  )

  return (
    <div className="space-y-6">
      <Panel className="overflow-hidden">
        {coverUrl && (
          <img src={coverUrl} alt="" className="h-44 w-full object-cover" />
        )}
        <div className="px-6 py-6">
          <h2 className="display text-2xl">{event.title}</h2>
          <p className="mt-2 text-sm text-muted">
            {formatDateTime(event.starts_at)}
            {event.ends_at ? ` to ${formatDateTime(event.ends_at)}` : ''}
            {event.location ? ` · ${event.location}` : ''}
          </p>
          <p className="mt-1 text-xs text-dim">Hosted by {names(hostNames)}</p>

          {event.description && (
            <p className="mt-5 text-sm leading-relaxed whitespace-pre-wrap text-muted">
              {event.description}
            </p>
          )}

          {error && (
            <div className="mt-5">
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button
              variant={mine?.status === 'going' ? 'primary' : undefined}
              size="sm"
              disabled={busy}
              onClick={() => rsvp('going')}
            >
              {mine?.status === 'going' ? "You're going" : 'Going'}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => rsvp('declined')}>
              {mine?.status === 'declined' ? "You said no" : "Can't make it"}
            </Button>
            {isHost && (
              <>
                <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(true)}
                  className="ml-auto text-xs text-dim transition-colors hover:text-red-400 disabled:opacity-50"
                >
                  Delete event
                </button>
              </>
            )}
          </div>
        </div>
      </Panel>

      <Panel className="px-6 py-5">
        <div className="eyebrow">Going · {going.length}</div>
        {going.length === 0 ? (
          <p className="mt-3 text-sm text-dim">Nobody yet.</p>
        ) : (
          <ul className="mt-4 flex flex-wrap gap-2">
            {going.map((i) => {
              const who = directory[i.profile_id]
              return (
                <li key={i.profile_id}>
                  <button
                    type="button"
                    onClick={() => who && setViewing(who)}
                    className="flex items-center gap-2 rounded-sm border border-line px-2.5 py-1.5 text-xs text-muted transition-colors hover:text-fg"
                  >
                    <Initials
                      name={who?.full_name ?? '?'}
                      url={who?.avatar_path ? avatars[who.avatar_path] : undefined}
                      role={who?.role}
                    />
                    {who?.full_name ?? 'Someone'}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {isHost && notInvited.length > 0 && (
          <form onSubmit={invite} className="mt-5 flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <Field label="Invite someone">
                <Select value={inviteId} onChange={(e) => setInviteId(e.target.value)}>
                  <option value="">Choose a member…</option>
                  {notInvited.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.full_name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button type="submit" size="sm" disabled={!inviteId || busy}>
              Invite
            </Button>
          </form>
        )}
      </Panel>

      {/* Switched off in src/lib/features.ts. An event thread is an ordinary
          feed post with an event_id, so it stays off while the feed does. */}
      {FEATURES.eventPosts && (
        <div>
          <SectionHeader title="About this event" caption="Posts here also show in the feed." />
          <PostFeed eventId={event.id} />
        </div>
      )}

      {editing && (
        <EventFormModal
          event={event}
          coHostIds={hostIds.filter((id) => id !== event.host_id)}
          directory={directory}
          onClose={() => setEditing(false)}
          onSaved={async (notice) => {
            setEditing(false)
            await onChanged(notice)
          }}
        />
      )}

      <ConfirmModal
        open={confirmingDelete}
        title={`Delete ${event.title}?`}
        body="Everyone's RSVPs and everything posted about this event go with it. This cannot be undone."
        confirmLabel="Delete event"
        onConfirm={remove}
        onClose={() => setConfirmingDelete(false)}
      />

      {viewing && <MemberCard member={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Creating and editing one                                                    */
/* -------------------------------------------------------------------------- */

/**
 * datetime-local wants "YYYY-MM-DDTHH:mm" in the browser's own timezone, and
 * what comes back from the database is an ISO instant. Built from the local
 * parts rather than slicing toISOString(), which would shift every edit by
 * the reader's offset and quietly move somebody's dinner.
 */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`
}

/** Two instants, however they were spelled. */
function sameMoment(a: string | null, b: string | null): boolean {
  return (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null)
}

/**
 * Whether the guests need telling. Only the four things somebody would have
 * to change their evening for — a tidied-up description mails nobody.
 */
function worthAnEmail(
  before: Event,
  after: { title: string; location: string | null; starts_at: string; ends_at: string | null },
): boolean {
  return (
    before.title !== after.title ||
    before.location !== after.location ||
    !sameMoment(before.starts_at, after.starts_at) ||
    !sameMoment(before.ends_at, after.ends_at)
  )
}

/**
 * One form for both. With an event it edits that event, without one it
 * creates a new one — the fields, the validation and the co-host picker are
 * identical, and the only real difference is that guests are invited on the
 * way in and added one at a time afterwards.
 */
function EventFormModal({
  event,
  coHostIds = [],
  directory,
  onClose,
  onSaved,
}: {
  /** Absent when creating. */
  event?: Event
  /** Co-hosts as they stand, so the picker can send back a difference. */
  coHostIds?: string[]
  directory: Record<string, DirectoryEntry>
  onClose: () => void
  onSaved: (notice?: string) => Promise<void>
}) {
  const { profile } = useAuth()
  const editing = Boolean(event)
  const creatorId = event?.host_id ?? profile?.id

  // Everybody the host could ask, connectors included. Anyone may RSVP to any
  // event anyway; an invitation is the nudge that puts it in front of them.
  const invitable = Object.values(directory)
    .filter((d) => d.id !== profile?.id)
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
  const connectorIds = invitable
    .filter((d) => d.role === 'connector')
    .map((d) => d.id)

  // A co-host edits, invites and cancels, which is hosting. So the same
  // people qualify — the database refuses anyone else through
  // may_host_events(), and this list is the polite version of that refusal.
  const hostable = Object.values(directory)
    .filter((d) => (d.role === 'connector' || d.role === 'admin') && d.id !== creatorId)
    .sort((a, b) => a.full_name.localeCompare(b.full_name))

  const [invitees, setInvitees] = useState<string[]>([])
  const [coHosts, setCoHosts] = useState<string[]>(coHostIds)
  const [title, setTitle] = useState(event?.title ?? '')
  const [startsAt, setStartsAt] = useState(toLocalInput(event?.starts_at))
  const [endsAt, setEndsAt] = useState(toLocalInput(event?.ends_at))
  const [location, setLocation] = useState(event?.location ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [cover, setCover] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    setError('')
    setBusy(true)

    // Editing without choosing a new file keeps the cover that is there.
    let coverPath: string | null = event?.cover_path ?? null
    if (cover) {
      try {
        const [uploaded] = await uploadMedia([cover])
        coverPath = uploaded?.path ?? coverPath
      } catch (uploadError) {
        setBusy(false)
        setError(errorMessage(uploadError))
        return
      }
    }

    const fields = {
      title: title.trim(),
      description: description.trim() || null,
      location: location.trim() || null,
      starts_at: new Date(startsAt).toISOString(),
      ends_at: endsAt ? new Date(endsAt).toISOString() : null,
      cover_path: coverPath,
    }

    let eventId = event?.id ?? ''
    if (event) {
      const { error: updateError } = await supabase
        .from('events')
        .update(fields)
        .eq('id', event.id)
      if (updateError) {
        setBusy(false)
        setError(errorMessage(updateError))
        return
      }
    } else {
      const { data: created, error: insertError } = await supabase
        .from('events')
        .insert({ host_id: profile.id, ...fields })
        .select('id')
        .single()
      if (insertError) {
        setBusy(false)
        setError(errorMessage(insertError))
        return
      }
      eventId = (created as { id: string }).id
    }

    // Everything past this point is worth saying out loud but is not a reason
    // to throw away an event that saved correctly. The problems travel back
    // with the reload instead.
    const problems: string[] = []

    // Co-hosts as a difference rather than a rewrite: somebody already
    // hosting is not removed and re-added, which would mail them again.
    const added = coHosts.filter((id) => !coHostIds.includes(id))
    const dropped = coHostIds.filter((id) => !coHosts.includes(id))

    if (added.length > 0) {
      const { error: addError } = await supabase
        .from('event_hosts')
        .insert(added.map((id) => ({ event_id: eventId, profile_id: id })))
      if (addError) problems.push(`The co-hosts were not added: ${errorMessage(addError)}`)
    }
    if (dropped.length > 0) {
      const { error: dropError } = await supabase
        .from('event_hosts')
        .delete()
        .eq('event_id', eventId)
        .in('profile_id', dropped)
      if (dropError) problems.push(`The co-hosts were not removed: ${errorMessage(dropError)}`)
    }

    if (!editing && invitees.length > 0) {
      const { error: inviteError } = await supabase.from('event_invitations').insert(
        invitees.map((id) => ({
          event_id: eventId,
          profile_id: id,
          status: 'invited',
        })),
      )
      if (inviteError) problems.push(`The invitations failed: ${errorMessage(inviteError)}`)
    }

    // Mail last, once the rows it describes are all in place.
    for (const id of added) {
      const mailError = await sendEventEmail('cohost', eventId, id)
      if (mailError) problems.push(`A co-host was not emailed: ${mailError}`)
    }
    if (!editing && invitees.length > 0) {
      // No profile_id: everybody currently on the list, which at this moment
      // is exactly the people just invited.
      const mailError = await sendEventEmail('invited', eventId)
      if (mailError) problems.push(`The invitation emails did not send: ${mailError}`)
    }
    if (event && worthAnEmail(event, fields)) {
      const mailError = await sendEventEmail('updated', eventId)
      if (mailError) problems.push(`Nobody was emailed about the change: ${mailError}`)
    }

    setBusy(false)
    await onSaved(problems.join(' ') || undefined)
  }

  return (
    <Modal open title={editing ? 'Edit event' : 'Create an event'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-5">
        <Field label="Title">
          <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>

        {/* Native datetime-local rather than a picker library. */}
        <Field label="Starts">
          <Input
            required
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </Field>

        <Field label="Ends" hint="Optional.">
          <Input
            type="datetime-local"
            value={endsAt}
            min={startsAt || undefined}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </Field>

        <Field label="Where">
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="The Hoxton, Shoreditch"
          />
        </Field>

        <Field label="What it is">
          <Textarea
            rows={4}
            value={description}
            maxLength={5000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <Field
          label="Cover image"
          hint={editing && event?.cover_path ? 'Optional. Leave empty to keep the one it has.' : 'Optional.'}
        >
          <input
            type="file"
            accept={ACCEPT_ATTR}
            onChange={(e) => setCover(e.target.files?.[0] ?? null)}
            className="block w-full text-xs text-dim file:mr-3 file:rounded-sm file:border file:border-line file:bg-transparent file:px-3 file:py-1.5 file:text-xs file:text-muted"
          />
        </Field>

        {hostable.length > 0 && (
          <fieldset className="border-0 p-0">
            <legend className="eyebrow">Hosting it with you</legend>
            <p className="mt-1 text-xs text-dim">
              Optional. A co-host can edit this event, invite people and cancel it, the same
              as you — so only connectors and administrators can be one.
            </p>

            <ul className="mt-3 max-h-36 space-y-1 overflow-y-auto">
              {hostable.map((person) => (
                <li key={person.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-sm px-1 py-1.5 text-sm hover:bg-gold-wash">
                    <input
                      type="checkbox"
                      checked={coHosts.includes(person.id)}
                      onChange={() =>
                        setCoHosts((s) =>
                          s.includes(person.id)
                            ? s.filter((x) => x !== person.id)
                            : [...s, person.id],
                        )
                      }
                      className="size-4 accent-gold"
                    />
                    <span className="min-w-0 flex-1 truncate text-fg">{person.full_name}</span>
                    <span className="shrink-0 text-xs text-dim">
                      {person.role === 'admin' ? 'Administrator' : 'Connector'}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}

        {/* Guests are invited on the way in. Afterwards they are added one at
            a time from the event itself, which is where the list lives. */}
        {!editing && invitable.length > 0 && (
          <fieldset className="border-0 p-0">
            <div className="flex items-center justify-between">
              <legend className="eyebrow">Invite</legend>
              <div className="flex gap-4 text-xs">
                {connectorIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setInvitees((s) =>
                        connectorIds.every((id) => s.includes(id))
                          ? s.filter((id) => !connectorIds.includes(id))
                          : [...new Set([...s, ...connectorIds])],
                      )
                    }
                    className="text-gold underline-offset-4 hover:underline"
                  >
                    All connectors
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setInvitees((s) =>
                      s.length === invitable.length ? [] : invitable.map((d) => d.id),
                    )
                  }
                  className="text-gold underline-offset-4 hover:underline"
                >
                  {invitees.length === invitable.length ? 'Clear all' : 'Everyone'}
                </button>
              </div>
            </div>

            <p className="mt-1 text-xs text-dim">
              Optional. Anyone in the network can see this event and RSVP; inviting
              someone puts it in front of them, emails them, and tells them it was meant
              for them.
            </p>

            <ul className="mt-3 max-h-44 space-y-1 overflow-y-auto">
              {invitable.map((person) => (
                <li key={person.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-sm px-1 py-1.5 text-sm hover:bg-gold-wash">
                    <input
                      type="checkbox"
                      checked={invitees.includes(person.id)}
                      onChange={() =>
                        setInvitees((s) =>
                          s.includes(person.id)
                            ? s.filter((x) => x !== person.id)
                            : [...s, person.id],
                        )
                      }
                      className="size-4 accent-gold"
                    />
                    <span className="min-w-0 flex-1 truncate text-fg">{person.full_name}</span>
                    <span className="shrink-0 text-xs text-dim">
                      {person.role === 'connector'
                        ? 'Connector'
                        : person.role === 'admin'
                          ? 'Administrator'
                          : 'Member'}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}

        {error && <Notice tone="error">{error}</Notice>}

        <div className="flex gap-3 pt-1">
          <Button type="button" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            className="flex-1"
            loading={busy}
            disabled={!title.trim() || !startsAt}
          >
            {editing ? 'Save changes' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
