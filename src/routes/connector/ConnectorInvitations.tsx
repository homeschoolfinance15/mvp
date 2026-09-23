import { CapacityBar, ConnectorShell, InviteCodes, useConnectorData } from './ConnectorDashboard'

/** `/connector/invitations`: capacity and the codes that spend it. */
export default function ConnectorInvitations() {
  const { connector, codes, people, loading, error, load } = useConnectorData()

  // Capacity is spent when someone actually joins, not when a code is issued,
  // so this mirrors public.connector_available_capacity exactly.
  const liveCodes = codes.filter((c) => c.status === 'active').length
  const capacity = connector?.invite_capacity ?? 0
  const remaining = Math.max(0, capacity - people.length)

  return (
    <ConnectorShell title="Invitations" loading={loading} error={error}>
      <CapacityBar
        status={connector?.invite_status ?? 'active'}
        joined={people.length}
        capacity={capacity}
        liveCodes={liveCodes}
      />
      <InviteCodes
        codes={codes}
        remaining={remaining}
        canInvite={connector?.invite_status === 'active'}
        onChanged={load}
      />
    </ConnectorShell>
  )
}
