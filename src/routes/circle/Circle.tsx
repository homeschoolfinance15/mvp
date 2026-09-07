import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { DashboardShell } from '../../components/DashboardShell'
import { MemberCard } from '../../components/MemberCard'
import {
  Button,
  ConfirmModal,
  EmptyState,
  Initials,
  Notice,
  Panel,
  Spinner,
} from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import { errorMessage, supabase } from '../../lib/supabase'
import type { CircleMessage, DirectoryEntry } from '../../lib/types'

/**
 * The room a member shares with everyone their connector brought in.
 *
 * Membership needs no table: connector_user_links already records who
 * invited whom, so my_circle_id() can name the room from facts that are
 * already true. An admin was never invited by anybody, belongs to no circle,
 * and is told so plainly rather than shown an empty screen.
 *
 * Live messages come from Supabase Realtime, which is already in the stack —
 * one subscription instead of a polling loop.
 */
export default function Circle() {
  const { profile } = useAuth()

  const [circleId, setCircleId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CircleMessage[]>([])
  const [directory, setDirectory] = useState<Record<string, DirectoryEntry>>({})
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [viewing, setViewing] = useState<DirectoryEntry | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const thread = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setError('')
    const [circleRes, messagesRes, dirRes] = await Promise.all([
      supabase.rpc('my_circle_id'),
      supabase.from('circle_messages').select('*').order('created_at', { ascending: true }),
      supabase.from('member_directory').select('*'),
    ])

    const firstError = [circleRes.error, messagesRes.error, dirRes.error].find(Boolean)
    if (firstError) setError(errorMessage(firstError))

    setCircleId((circleRes.data as string | null) ?? null)
    setMessages((messagesRes.data as CircleMessage[]) ?? [])
    setDirectory(
      Object.fromEntries(((dirRes.data as DirectoryEntry[]) ?? []).map((d) => [d.id, d])),
    )
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Live inserts. The select policy already scopes what arrives, and the
  // circleId check is belt and braces for a message that isn't ours.
  useEffect(() => {
    if (!circleId) return

    const channel = supabase
      .channel(`circle:${circleId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'circle_messages' },
        (payload) => {
          const message = payload.new as CircleMessage
          if (message.connector_id !== circleId) return
          setMessages((current) =>
            current.some((m) => m.id === message.id) ? current : [...current, message],
          )
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [circleId])

  // Scroll the thread, not the page: scrollIntoView on a nested scroller
  // drags the whole document with it and the header jumps.
  useEffect(() => {
    const el = thread.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!profile || !circleId || !draft.trim()) return
    setBusy(true)
    setError('')

    const { data, error: insertError } = await supabase
      .from('circle_messages')
      .insert({ connector_id: circleId, author_id: profile.id, body: draft.trim() })
      .select()
      .single()

    setBusy(false)
    if (insertError) {
      setError(errorMessage(insertError))
      return
    }
    setDraft('')
    // Realtime will also deliver this; the id check above keeps it single.
    const message = data as CircleMessage
    setMessages((current) =>
      current.some((m) => m.id === message.id) ? current : [...current, message],
    )
  }

  async function remove(id: string) {
    setConfirmingId(null)
    const { error: deleteError } = await supabase.from('circle_messages').delete().eq('id', id)
    if (deleteError) {
      setError(errorMessage(deleteError))
      return
    }
    setMessages((current) => current.filter((m) => m.id !== id))
  }

  return (
    <DashboardShell
      title="Your circle"
      caption="Everyone your connector brought in, and the connector themselves."
    >
      {loading ? (
        <div className="flex justify-center py-16 text-dim">
          <Spinner />
        </div>
      ) : !circleId ? (
        // An error here must not read as an empty room: "you aren't in a
        // circle" and "we couldn't find out" are different facts.
        <div className="mx-auto max-w-2xl">
          {error ? (
            <Notice tone="error">{error}</Notice>
          ) : (
            <EmptyState>
              {profile?.role === 'admin'
                ? "Administrators aren't part of a circle — nobody invited you in, so there's no room to join."
                : "You aren't in a circle yet."}
            </EmptyState>
          )}
        </div>
      ) : (
        <div className="mx-auto flex max-w-2xl flex-col">
          {error && (
            <div className="mb-4">
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          <Panel className="flex min-h-0 flex-col">
            <div
              ref={thread}
              className="max-h-[60vh] min-h-[16rem] flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5"
            >
              {messages.length === 0 ? (
                <p className="py-10 text-center text-sm text-dim">
                  Nothing said yet. Start it off.
                </p>
              ) : (
                messages.map((message) => {
                  const who = directory[message.author_id]
                  const mine = message.author_id === profile?.id
                  return (
                    <div
                      key={message.id}
                      className={`group flex gap-3 ${mine ? 'flex-row-reverse' : ''}`}
                    >
                      <button
                        type="button"
                        onClick={() => who && setViewing(who)}
                        className="mt-0.5 shrink-0"
                        aria-label={who?.full_name ?? 'Member'}
                      >
                        <Initials name={who?.full_name ?? '?'} />
                      </button>

                      <div className={`min-w-0 max-w-[80%] ${mine ? 'text-right' : ''}`}>
                        <div className="text-xs text-dim">
                          {mine ? 'You' : (who?.full_name ?? 'Someone')}
                        </div>
                        <div
                          className={`mt-1 inline-block rounded-sm px-3 py-2 text-left text-sm leading-relaxed break-words whitespace-pre-wrap ${
                            mine
                              ? 'bg-gold-wash text-fg'
                              : 'border border-line text-muted'
                          }`}
                        >
                          {message.body}
                        </div>
                      </div>

                      {mine && (
                        <button
                          type="button"
                          onClick={() => setConfirmingId(message.id)}
                          className="self-center text-xs text-dim transition hover:text-red-400 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                          aria-label="Delete message"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  )
                })
              )}

            </div>

            <form
              onSubmit={send}
              className="flex items-center gap-2 border-t border-line px-4 py-3 sm:px-5"
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={2000}
                placeholder="Say something to your circle"
                className="h-10 min-w-0 flex-1 rounded-sm border border-line bg-transparent px-3 text-sm text-fg placeholder:text-dim focus:border-gold focus:outline-none"
              />
              <Button type="submit" size="sm" variant="primary" disabled={!draft.trim() || busy}>
                Send
              </Button>
            </form>
          </Panel>
        </div>
      )}

      <ConfirmModal
        open={confirmingId !== null}
        title="Delete this message?"
        body="It disappears for everyone in the circle. This cannot be undone."
        onConfirm={() => confirmingId && remove(confirmingId)}
        onClose={() => setConfirmingId(null)}
      />

      {viewing && <MemberCard member={viewing} onClose={() => setViewing(null)} />}
    </DashboardShell>
  )
}
