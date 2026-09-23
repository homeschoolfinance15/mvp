import { useCallback, useEffect, useState } from 'react'
import {
  EmptyState,
  formatDate,
  Initials,
  Notice,
  Panel,
  Spinner,
  StatusBadge,
} from '../../components/ui'
import { useLive } from '../../lib/live'
import { errorMessage, supabase } from '../../lib/supabase'
import type { CircleMessage, Profile } from '../../lib/types'
import { byId, loadConnectors, loadLinks, loadProfiles, type ConnectorRow, type LinkRow } from './shared'

/**
 * The network as it is actually shaped: every connector, and beneath each one
 * the people they brought in.
 *
 * The hierarchy is not stored anywhere. connector_user_links already records
 * who invited whom, so this is that fact drawn out rather than a second copy
 * of it. Collapsing uses a native <details>, which needs no state.
 *
 * Conversations appear here because an administrator was given read access on
 * purpose (20260907000007_admin_reads_circles.sql). Reading a room is still
 * not speaking in it: the insert policy requires being inside one, and an
 * admin belongs to no circle.
 */
export default function Circles() {
  const [connectors, setConnectors] = useState<ConnectorRow[]>([])
  const [links, setLinks] = useState<LinkRow[]>([])
  const [profilesById, setProfilesById] = useState<Record<string, Profile>>({})
  const [messages, setMessages] = useState<CircleMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    setLoadError('')
    const [connectorsRes, linksRes, profilesRes, circlesRes] = await Promise.all([
      loadConnectors(),
      loadLinks(),
      loadProfiles(),
      supabase
        .from('circle_messages')
        .select('*')
        // Newest 500, reversed below, so recent conversation is never cut off.
        .order('created_at', { ascending: false })
        .limit(500),
    ])

    const firstError = [
      connectorsRes.error,
      linksRes.error,
      profilesRes.error,
      circlesRes.error,
    ].find(Boolean)
    if (firstError) setLoadError(errorMessage(firstError))

    setConnectors((connectorsRes.data as unknown as ConnectorRow[]) ?? [])
    setLinks((linksRes.data as unknown as LinkRow[]) ?? [])
    setProfilesById(byId((profilesRes.data as Profile[]) ?? []))
    setMessages(((circlesRes.data as CircleMessage[]) ?? []).reverse())
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Circles move when somebody is added to one or posts in it.
  // `circle_messages` has been in the realtime publication since the circle
  // chat shipped; this is the administrator's read-only view of the same
  // thing, and it holds nothing unsaved.
  useLive(
    ['connectors', 'connector_user_links', 'profiles', 'circle_messages'],
    () => void load(),
  )

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-dim">
        <Spinner />
      </div>
    )
  }

  return (
    <>
      {loadError && (
        <div className="mb-8">
          <Notice tone="error">{loadError}</Notice>
        </div>
      )}

      {connectors.length === 0 ? (
        <EmptyState>Create a connector to start the first circle.</EmptyState>
      ) : (
        <div className="space-y-4">
          {connectors.map((connector) => {
            const members = links
              .filter((l) => l.connector_id === connector.id)
              .map((l) => profilesById[l.user_profile_id])
              .filter(Boolean)
            const said = messages.filter((m) => m.connector_id === connector.id)

            return (
              <Panel key={connector.id} className="overflow-hidden">
                <details>
                  <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-4 transition-colors hover:bg-fg/[0.02]">
                    <Initials name={connector.profiles?.full_name ?? '?'} role="connector" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">
                        {connector.profiles?.full_name ?? 'Unknown'}
                      </span>
                      <span className="block truncate text-xs text-dim">
                        {said.length === 0
                          ? 'No messages'
                          : `${said.length} ${said.length === 1 ? 'message' : 'messages'} · last ${formatDate(said[said.length - 1].created_at)}`}
                      </span>
                    </span>
                  </summary>

                  <div className="border-t border-line">
                    {members.length === 0 ? (
                      <p className="px-5 py-4 text-sm text-dim">
                        Nobody has joined on their codes yet.
                      </p>
                    ) : (
                      <ul className="divide-y divide-line">
                        {members.map((member) => (
                          <li key={member.id} className="flex items-center gap-3 py-3 pr-5 pl-10">
                            <Initials name={member.full_name} role={member.role} />
                            <span className="min-w-0">
                              <span className="block truncate text-sm text-fg">
                                {member.full_name}
                              </span>
                              <span className="block truncate text-xs text-dim">
                                {member.current_profession ?? 'No profession listed'}
                              </span>
                            </span>
                            <span className="ml-auto shrink-0">
                              <StatusBadge status={member.profile_status} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {said.length > 0 && (
                      <details className="border-t border-line">
                        <summary className="cursor-pointer px-5 py-3 text-xs tracking-[0.1em] text-dim uppercase hover:text-fg">
                          Conversation &middot; {said.length}
                        </summary>
                        <ul className="space-y-3 bg-fg/[0.015] px-5 py-4">
                          {said.map((message) => (
                            <li key={message.id} className="text-sm">
                              <span className="text-xs text-dim">
                                {profilesById[message.author_id]?.full_name ?? 'Someone'}{' '}
                                &middot; {formatDate(message.created_at)}
                              </span>
                              <p className="mt-0.5 leading-relaxed break-words whitespace-pre-wrap text-muted">
                                {message.body}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                </details>
              </Panel>
            )
          })}
        </div>
      )}
    </>
  )
}
