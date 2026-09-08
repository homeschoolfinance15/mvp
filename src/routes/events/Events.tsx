import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
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
import { ACCEPT_ATTR, signMedia, uploadMedia } from '../../lib/media'
import { errorMessage, loadFailed, supabase } from '../../lib/supabase'
import type {
  DirectoryEntry,
  Event,
  EventInvitation,
  RsvpStatus,
} from '../../lib/types'

/**
 * Luma semantics inside a private network: everyone on the platform sees
 * every event and anyone may RSVP. A host's invitation is a nudge, not a
 * gate — discovery has to be open or nothing gets discovered. The front door
 * is the gate, and the waitlist never gets through it.
 *
 * Hosting is narrower: connectors and admins, enforced by can_host_events().
 */
export default function Events() {
  const { profile } = useAuth()

  const [tab, setTab] = useState('upcoming')
  const [events, setEvents] = useState<Event[]>([])
  const [invitations, setInvitations] = useState<EventInvitation[]>([])
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
    const [eventsRes, invitesRes, dirRes] = await Promise.all([
      supabase.from('events').select('*').order('starts_at', { ascending: true }),
      supabase.from('event_invitations').select('*'),
      supabase.from('member_directory').select('*'),
    ])

    const firstError = [eventsRes.error, invitesRes.error, dirRes.error].find(Boolean)
    if (firstError) {
      loadFailed(firstError, 'events')
      setFailed(true)
      setLoading(false)
      return
    }

    const rows = (eventsRes.data as Event[]) ?? []
    setEvents(rows)
    setInvitations((invitesRes.data as EventInvitation[]) ?? [])
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
                  directory={directory}
                  avatars={covers}
                  onChanged={load}
                />
              ) : (
                <div className="hidden lg:block">
                  <EmptyState>Select an event to see it.</EmptyState>
                </div>
              )}
            </section>
          </div>

          {creating && (
            <CreateEventModal
              directory={directory}
              onClose={() => setCreating(false)}
              onCreated={async () => {
                setCreating(false)
                await load()
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
  directory,
  avatars,
  onChanged,
}: {
  event: Event
  coverUrl?: string
  invitations: EventInvitation[]
  directory: Record<string, DirectoryEntry>
  /** Covers and faces share one signed-URL map — see the load above. */
  avatars: Record<string, string>
  onChanged: () => Promise<void>
}) {
  const { profile } = useAuth()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [inviteId, setInviteId] = useState('')
  const [viewing, setViewing] = useState<DirectoryEntry | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const mine = invitations.find((i) => i.profile_id === profile?.id)
  const going = invitations.filter((i) => i.status === 'going')
  const isHost = event.host_id === profile?.id || profile?.role === 'admin'
  const host = directory[event.host_id]

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
    setBusy(false)
    if (insertError) {
      setError(
        insertError.code === '23505'
          ? 'They are already on the list.'
          : errorMessage(insertError),
      )
      return
    }
    setInviteId('')
    await onChanged()
  }

  async function remove() {
    setConfirmingDelete(false)
    const { error: deleteError } = await supabase.from('events').delete().eq('id', event.id)
    if (deleteError) {
      setError(errorMessage(deleteError))
      return
    }
    await onChanged()
  }

  const notInvited = Object.values(directory).filter(
    (d) => !invitations.some((i) => i.profile_id === d.id),
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
          <p className="mt-1 text-xs text-dim">
            Hosted by {host?.full_name ?? 'someone'}
          </p>

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
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="ml-auto text-xs text-dim transition-colors hover:text-red-400"
              >
                Delete event
              </button>
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

      <div>
        <SectionHeader title="About this event" caption="Posts here also show in the feed." />
        <PostFeed eventId={event.id} />
      </div>

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
/* Creating one                                                                */
/* -------------------------------------------------------------------------- */

function CreateEventModal({
  directory,
  onClose,
  onCreated,
}: {
  directory: Record<string, DirectoryEntry>
  onClose: () => void
  onCreated: () => Promise<void>
}) {
  const { profile } = useAuth()

  // Everybody the host could ask, connectors included. Anyone may RSVP to any
  // event anyway; an invitation is the nudge that puts it in front of them.
  const invitable = Object.values(directory)
    .filter((d) => d.id !== profile?.id)
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
  const connectorIds = invitable
    .filter((d) => d.role === 'connector')
    .map((d) => d.id)

  const [invitees, setInvitees] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [location, setLocation] = useState('')
  const [description, setDescription] = useState('')
  const [cover, setCover] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    setError('')
    setBusy(true)

    let coverPath: string | null = null
    if (cover) {
      try {
        const [uploaded] = await uploadMedia([cover])
        coverPath = uploaded?.path ?? null
      } catch (uploadError) {
        setBusy(false)
        setError(errorMessage(uploadError))
        return
      }
    }

    const { data: created, error: insertError } = await supabase
      .from('events')
      .insert({
        host_id: profile.id,
        title: title.trim(),
        description: description.trim() || null,
        location: location.trim() || null,
        starts_at: new Date(startsAt).toISOString(),
        ends_at: endsAt ? new Date(endsAt).toISOString() : null,
        cover_path: coverPath,
      })
      .select('id')
      .single()

    if (insertError) {
      setBusy(false)
      setError(errorMessage(insertError))
      return
    }

    // The event exists either way. A failed invitation is worth saying out
    // loud, but it is not a reason to throw the event away — the host can
    // invite the rest from the event itself.
    if (invitees.length > 0 && created) {
      const { error: inviteError } = await supabase.from('event_invitations').insert(
        invitees.map((id) => ({
          event_id: (created as { id: string }).id,
          profile_id: id,
          status: 'invited',
        })),
      )
      if (inviteError) {
        setBusy(false)
        setError(`The event was created, but the invitations failed: ${errorMessage(inviteError)}`)
        await onCreated()
        return
      }
    }

    setBusy(false)
    await onCreated()
  }

  return (
    <Modal open title="Create an event" onClose={onClose}>
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

        <Field label="Cover image" hint="Optional.">
          <input
            type="file"
            accept={ACCEPT_ATTR}
            onChange={(e) => setCover(e.target.files?.[0] ?? null)}
            className="block w-full text-xs text-dim file:mr-3 file:rounded-sm file:border file:border-line file:bg-transparent file:px-3 file:py-1.5 file:text-xs file:text-muted"
          />
        </Field>

        {invitable.length > 0 && (
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
              someone puts it in front of them and tells them it was meant for them.
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
            Create
          </Button>
        </div>
      </form>
    </Modal>
  )
}
