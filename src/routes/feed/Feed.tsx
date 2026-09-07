import { DashboardShell } from '../../components/DashboardShell'
import { ForYou } from '../../components/ForYou'
import { PostFeed } from '../../components/PostFeed'

export default function Feed() {
  return (
    <DashboardShell
      title="Feed"
      caption="What the network is doing, thinking and building. Everyone here can see this."
    >
      <div className="mx-auto max-w-2xl">
        <ForYou />
      </div>
      <PostFeed />
    </DashboardShell>
  )
}
