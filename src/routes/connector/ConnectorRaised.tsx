import { DashboardShell } from '../../components/DashboardShell'
import { FlagsPanel } from '../../components/FlagsPanel'

/** `/connector/raised`. FlagsPanel loads for itself. */
export default function ConnectorRaised() {
  return (
    <DashboardShell title="Raised">
      <FlagsPanel />
    </DashboardShell>
  )
}
