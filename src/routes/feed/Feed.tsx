import { DashboardShell } from '../../components/DashboardShell'
import { PostFeed } from '../../components/PostFeed'

export default function Feed() {
  return (
    <DashboardShell
      title="Feed"
      caption="What the network is doing, thinking and building. Everyone here can see this."
    >
      <PostFeed />
    </DashboardShell>
  )
}
