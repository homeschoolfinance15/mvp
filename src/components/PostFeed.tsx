import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { MemberCard } from './MemberCard'
import {
  Button,
  EmptyState,
  formatDate,
  Initials,
  Notice,
  Panel,
  Spinner,
  Textarea,
} from './ui'
import { useAuth } from '../context/AuthProvider'
import { ACCEPT_ATTR, removeMedia, signMedia, uploadMedia } from '../lib/media'
import { errorMessage, supabase } from '../lib/supabase'
import type {
  DirectoryEntry,
  MediaItem,
  Post,
  PostComment,
  PostLike,
} from '../lib/types'

const PAGE_SIZE = 50

/**
 * Posts, likes and comments — the whole surface, in one component.
 *
 * With no eventId it is the network-wide feed. With one it is the thread
 * hanging off an event, reading and writing the same posts table through the
 * nullable event_id column. One implementation, so a post behaves the same
 * in both places rather than drifting into two half-features.
 *
 * Author names come from member_directory rather than an embedded profiles
 * join: PostgREST embedding across a view is unreliable, and the roster is
 * small enough to fetch whole and join in a map — the shape AdminDashboard
 * already uses for profilesById.
 *
 * ponytail: newest 50, no infinite scroll. Add range() paging when the
 * network is big enough for anyone to reach the bottom.
 */
export function PostFeed({ eventId }: { eventId?: string }) {
  const { profile } = useAuth()

  const [posts, setPosts] = useState<Post[]>([])
  const [directory, setDirectory] = useState<Record<string, DirectoryEntry>>({})
  const [likes, setLikes] = useState<PostLike[]>([])
  const [comments, setComments] = useState<PostComment[]>([])
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [viewing, setViewing] = useState<DirectoryEntry | null>(null)

  const load = useCallback(async () => {
    setError('')

    // Scoped to one event, or the whole network when eventId is absent.
    const postsQuery = supabase
      .from('posts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE)

    const [postsRes, dirRes] = await Promise.all([
      eventId ? postsQuery.eq('event_id', eventId) : postsQuery,
      supabase.from('member_directory').select('*'),
    ])

    const firstError = [postsRes.error, dirRes.error].find(Boolean)
    if (firstError) {
      setError(errorMessage(firstError))
      setLoading(false)
      return
    }

    const rows = (postsRes.data as Post[]) ?? []
    const ids = rows.map((p) => p.id)

    // Likes and comments for the page in view, so counts and "did I like
    // this" come from one round trip each rather than a counter column that
    // has to be kept true.
    const [likesRes, commentsRes] = ids.length
      ? await Promise.all([
          supabase.from('post_likes').select('*').in('post_id', ids),
          supabase
            .from('post_comments')
            .select('*')
            .in('post_id', ids)
            .order('created_at', { ascending: true }),
        ])
      : [{ data: [], error: null }, { data: [], error: null }]

    setPosts(rows)
    setDirectory(
      Object.fromEntries(((dirRes.data as DirectoryEntry[]) ?? []).map((d) => [d.id, d])),
    )
    setLikes((likesRes.data as PostLike[]) ?? [])
    setComments((commentsRes.data as PostComment[]) ?? [])

    const paths = rows.flatMap((p) => (p.media ?? []).map((m) => m.path))
    if (paths.length) {
      try {
        setMediaUrls(await signMedia(paths))
      } catch {
        // A dead image is not worth failing the whole feed over.
        setMediaUrls({})
      }
    }

    setLoading(false)
  }, [eventId])

  useEffect(() => {
    void load()
  }, [load])

  const likesByPost = useMemo(() => {
    const map: Record<string, PostLike[]> = {}
    for (const like of likes) (map[like.post_id] ??= []).push(like)
    return map
  }, [likes])

  const commentsByPost = useMemo(() => {
    const map: Record<string, PostComment[]> = {}
    for (const c of comments) (map[c.post_id] ??= []).push(c)
    return map
  }, [comments])

  /** Likes and comments move in local state; only structure change refetches. */
  function toggleLike(postId: string, liked: boolean) {
    if (!profile) return
    setLikes((current) =>
      liked
        ? current.filter((l) => !(l.post_id === postId && l.profile_id === profile.id))
        : [...current, { post_id: postId, profile_id: profile.id, created_at: '' }],
    )

    const query = liked
      ? supabase.from('post_likes').delete().eq('post_id', postId).eq('profile_id', profile.id)
      : supabase.from('post_likes').insert({ post_id: postId, profile_id: profile.id })

    void query.then(({ error: e }) => {
      if (e) {
        setError(errorMessage(e))
        void load()
      }
    })
  }

  return (
    <>
      {loading ? (
        <div className="flex justify-center py-16 text-dim">
          <Spinner />
        </div>
      ) : (
        <div className="mx-auto max-w-2xl">
          {error && (
            <div className="mb-6">
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          <Composer eventId={eventId} onPosted={load} />

          <div className="mt-10 space-y-5">
            {posts.length === 0 ? (
              <EmptyState>
                {eventId
                  ? 'Nothing said about this yet.'
                  : 'Nothing here yet. Be the first to say something.'}
              </EmptyState>
            ) : (
              posts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  author={directory[post.author_id]}
                  directory={directory}
                  likes={likesByPost[post.id] ?? []}
                  comments={commentsByPost[post.id] ?? []}
                  mediaUrls={mediaUrls}
                  onToggleLike={toggleLike}
                  onCommentAdded={(c) => setComments((cs) => [...cs, c])}
                  onCommentRemoved={(id) =>
                    setComments((cs) => cs.filter((c) => c.id !== id))
                  }
                  onDeleted={load}
                  onViewMember={setViewing}
                />
              ))
            )}
          </div>

          {viewing && <MemberCard member={viewing} onClose={() => setViewing(null)} />}
        </div>
      )}
    </>
  )
}


/* -------------------------------------------------------------------------- */
/* Composer                                                                    */
/* -------------------------------------------------------------------------- */

function Composer({
  eventId,
  onPosted,
}: {
  eventId?: string
  onPosted: () => Promise<void>
}) {
  const { profile } = useAuth()
  const fileInput = useRef<HTMLInputElement>(null)

  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const canSubmit = (body.trim().length > 0 || files.length > 0) && !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!profile || !canSubmit) return
    setError('')
    setBusy(true)

    let media: MediaItem[] = []
    try {
      media = await uploadMedia(files)
    } catch (uploadError) {
      setBusy(false)
      setError(errorMessage(uploadError))
      return
    }

    const { error: insertError } = await supabase
      .from('posts')
      .insert({ author_id: profile.id, body: body.trim(), media, event_id: eventId ?? null })

    if (insertError) {
      // The row failed, so the objects it would have pointed at are orphans.
      await removeMedia(media.map((m) => m.path))
      setBusy(false)
      setError(errorMessage(insertError))
      return
    }

    setBody('')
    setFiles([])
    if (fileInput.current) fileInput.current.value = ''
    setBusy(false)
    await onPosted()
  }

  return (
    <Panel className="px-5 py-5">
      <form onSubmit={submit} className="space-y-4">
        <Textarea
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={5000}
          placeholder={
            eventId
              ? 'Say something about this event'
              : `What's on your mind, ${profile?.full_name.split(' ')[0] ?? 'friend'}?`
          }
        />

        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {files.map((file, i) => (
              <li
                key={`${file.name}-${i}`}
                className="flex items-center gap-2 rounded-sm border border-line px-2.5 py-1.5 text-xs text-muted"
              >
                <span className="max-w-[12rem] truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() => setFiles((f) => f.filter((_, j) => j !== i))}
                  className="text-dim transition-colors hover:text-fg"
                  aria-label={`Remove ${file.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <Notice tone="error">{error}</Notice>}

        <div className="flex items-center justify-between gap-4">
          <label className="cursor-pointer text-xs tracking-[0.1em] text-dim uppercase transition-colors hover:text-fg">
            Add media
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT_ATTR}
              className="hidden"
              onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 10))}
            />
          </label>

          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!canSubmit}>
            Post
          </Button>
        </div>
      </form>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/* A post                                                                      */
/* -------------------------------------------------------------------------- */

function PostCard({
  post,
  author,
  directory,
  likes,
  comments,
  mediaUrls,
  onToggleLike,
  onCommentAdded,
  onCommentRemoved,
  onDeleted,
  onViewMember,
}: {
  post: Post
  author?: DirectoryEntry
  directory: Record<string, DirectoryEntry>
  likes: PostLike[]
  comments: PostComment[]
  mediaUrls: Record<string, string>
  onToggleLike: (postId: string, liked: boolean) => void
  onCommentAdded: (comment: PostComment) => void
  onCommentRemoved: (id: string) => void
  onDeleted: () => Promise<void>
  onViewMember: (member: DirectoryEntry) => void
}) {
  const { profile } = useAuth()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const liked = likes.some((l) => l.profile_id === profile?.id)
  const mine = post.author_id === profile?.id
  const canModerate = mine || profile?.role === 'admin'

  async function addComment(e: FormEvent) {
    e.preventDefault()
    if (!profile || !draft.trim()) return
    setBusy(true)
    setError('')

    const { data, error: insertError } = await supabase
      .from('post_comments')
      .insert({ post_id: post.id, author_id: profile.id, body: draft.trim() })
      .select()
      .single()

    setBusy(false)
    if (insertError) {
      setError(errorMessage(insertError))
      return
    }
    setDraft('')
    onCommentAdded(data as PostComment)
  }

  async function removeComment(id: string) {
    const { error: deleteError } = await supabase.from('post_comments').delete().eq('id', id)
    if (deleteError) {
      setError(errorMessage(deleteError))
      return
    }
    onCommentRemoved(id)
  }

  async function deletePost() {
    const { error: deleteError } = await supabase.from('posts').delete().eq('id', post.id)
    if (deleteError) {
      setError(errorMessage(deleteError))
      return
    }
    // The row is gone; the objects it referenced are not.
    await removeMedia((post.media ?? []).map((m) => m.path))
    await onDeleted()
  }

  return (
    <Panel className="px-5 py-5">
      <header className="flex items-start gap-3">
        <Initials name={author?.full_name ?? '?'} />
        <div className="min-w-0 flex-1">
          {author ? (
            <button
              type="button"
              onClick={() => onViewMember(author)}
              className="max-w-full truncate text-sm font-medium text-fg transition-colors hover:text-gold"
            >
              {author.full_name}
            </button>
          ) : (
            <div className="truncate text-sm font-medium text-fg">
              Someone no longer on the network
            </div>
          )}
          <div className="truncate text-xs text-dim">
            {author?.current_profession ?? '—'} · {formatDate(post.created_at)}
          </div>
        </div>
        {canModerate && (
          <button
            type="button"
            onClick={deletePost}
            className="shrink-0 text-xs text-dim transition-colors hover:text-red-400"
          >
            Delete
          </button>
        )}
      </header>

      {post.body && (
        <p className="mt-4 text-sm leading-relaxed whitespace-pre-wrap text-fg">{post.body}</p>
      )}

      {(post.media ?? []).length > 0 && (
        <div
          className={`mt-4 grid gap-2 ${post.media.length > 1 ? 'sm:grid-cols-2' : ''}`}
        >
          {post.media.map((item) =>
            item.kind === 'video' ? (
              <video
                key={item.path}
                src={mediaUrls[item.path]}
                controls
                className="w-full rounded-sm border border-line"
              />
            ) : (
              <img
                key={item.path}
                src={mediaUrls[item.path]}
                alt=""
                loading="lazy"
                className="w-full rounded-sm border border-line object-cover"
              />
            ),
          )}
        </div>
      )}

      <div className="mt-4 flex items-center gap-5 border-t border-line pt-3.5 text-xs">
        <button
          type="button"
          onClick={() => onToggleLike(post.id, liked)}
          className={`transition-colors ${liked ? 'text-gold' : 'text-dim hover:text-fg'}`}
          aria-pressed={liked}
        >
          {liked ? '♥' : '♡'} {likes.length > 0 && <span className="tabular-nums">{likes.length}</span>}
        </button>
        <span className="text-dim tabular-nums">
          {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
        </span>
      </div>

      {comments.length > 0 && (
        <ul className="mt-3.5 space-y-2.5 border-t border-line pt-3.5">
          {comments.map((comment) => {
            const who = directory[comment.author_id]
            const removable =
              comment.author_id === profile?.id || mine || profile?.role === 'admin'
            return (
              <li key={comment.id} className="group flex items-baseline gap-2 text-sm">
                {who ? (
                  <button
                    type="button"
                    onClick={() => onViewMember(who)}
                    className="shrink-0 font-medium text-fg transition-colors hover:text-gold"
                  >
                    {who.full_name}
                  </button>
                ) : (
                  <span className="shrink-0 font-medium text-fg">Someone</span>
                )}
                <span className="min-w-0 flex-1 break-words text-muted">{comment.body}</span>
                {removable && (
                  <button
                    type="button"
                    onClick={() => removeComment(comment.id)}
                    className="shrink-0 text-xs text-dim opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                    aria-label="Delete comment"
                  >
                    ×
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <form onSubmit={addComment} className="mt-3.5 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={2000}
          placeholder="Add a comment"
          className="h-9 min-w-0 flex-1 rounded-sm border border-line bg-transparent px-3 text-sm text-fg placeholder:text-dim focus:border-gold focus:outline-none"
        />
        <Button type="submit" size="sm" disabled={!draft.trim() || busy}>
          Reply
        </Button>
      </form>
    </Panel>
  )
}
