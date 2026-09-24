import { useState } from 'react'
import { EmptyState, Initials, Panel } from '../../components/ui'
import { ConnectorShell, PersonDetail, useConnectorData } from './ConnectorDashboard'

/** `/connector/people`: the people who joined on this connector's codes. */
export default function ConnectorPeople() {
  const { connector, people, notes, loading, error, load } = useConnectorData()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = people.find((p) => p.profile.id === selectedId) ?? null

  return (
    <ConnectorShell title="People" loading={loading} error={error}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section>
          {people.length > 0 && (
            <p className="mb-4 text-sm text-muted">Select someone to read and add private context.</p>
          )}
          {people.length === 0 ? (
            <EmptyState>Nobody has joined on your codes yet.</EmptyState>
          ) : (
            <Panel className="divide-y divide-line">
              {people.map((person) => {
                const noteCount = notes.filter(
                  (n) => n.user_profile_id === person.profile.id,
                ).length
                const active = person.profile.id === selectedId
                return (
                  <button
                    key={person.linkId}
                    type="button"
                    onClick={() => {
                      setSelectedId(person.profile.id)
                      // Below lg the context panel is under the list,
                      // off the bottom of the screen.
                      if (window.innerWidth < 1024) {
                        requestAnimationFrame(() =>
                          document
                            .getElementById('person-detail')
                            ?.scrollIntoView({ behavior: 'smooth' }),
                        )
                      }
                    }}
                    className={`flex w-full items-center gap-3.5 px-5 py-4 text-left transition-colors ${
                      active ? 'bg-raised' : 'hover:bg-raised/60'
                    }`}
                  >
                    <Initials name={person.profile.full_name} role={person.profile.role} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">
                        {person.profile.full_name}
                      </span>
                      <span className="block truncate text-xs text-dim">
                        {person.profile.current_profession ?? 'Onboarding not finished'}
                      </span>
                    </span>
                    {noteCount > 0 && (
                      <span className="text-xs tabular-nums text-dim">
                        {noteCount} note{noteCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </button>
                )
              })}
            </Panel>
          )}
        </section>

        <section id="person-detail" className="scroll-mt-20">
          {selected && connector && (
            <PersonDetail
              key={selected.profile.id}
              person={selected}
              connectorId={connector.id}
              notes={notes.filter((n) => n.user_profile_id === selected.profile.id)}
              onChanged={load}
            />
          )}
        </section>
      </div>
    </ConnectorShell>
  )
}
