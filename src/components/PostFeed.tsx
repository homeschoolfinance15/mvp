import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { MemberCard } from './MemberCard'
import {
  applyMention,
  MentionPicker,
  MentionText,
  useCaret,
  useMentions,
} from './Mentions'
import {
  Button,
  ConfirmModal,
  EmptyState,
  formatDate,
  Initials,
  LoadFailed,
  Notice,
  Panel,
  Spinner,
  Textarea,
} from './ui'
import { useAuth } from '../context/AuthProvider'
import { ACCEPT_ATTR, removeMedia, signMedia, uploadMedia } from '../lib/media'
import { errorMessage, loadFailed, supabase } from '../lib/supabase'
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
  // A page that failed to load is a different thing from an action that
  // failed, and gets a different, quieter treatment.
  const [failed, setFailed] = useState(false)
  const [viewing, setViewing] = useState<DirectoryEntry | null>(null)

  const load = useCallback(async () => {
    setError('')
    setFailed(false)

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
      loadFailed(firstError, eventId ? 'this thread' : 'the feed')
      setFailed(true)
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

    // Post media and every author's picture, signed in one request.
    const directoryRows = (dirRes.data as DirectoryEntry[]) ?? []
    const paths = [
      ...rows.flatMap((p) => (p.media ?? []).map((m) => m.path)),
      ...directoryRows.map((d) => d.avatar_path).filter((p): p is string => Boolean(p)),
    ]
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
          {failed ? (
            <LoadFailed what={eventId ? 'this thread' : 'the feed'} onRetry={load} />
          ) : (
            <>
          {error && (
            <div className="mb-6">
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          <Composer eventId={eventId} directory={directory} onPosted={load} />

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
            </>
          )}

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
  directory,
  onPosted,
}: {
  eventId?: string
  directory: Record<string, DirectoryEntry>
  onPosted: () => Promise<void>
}) {
  const { profile } = useAuth()
  const fileInput = useRef<HTMLInputElement>(null)
  const { ref: bodyRef, caret, setCaret, sync } = useCaret()
  const { mentioned, setMentioned, people, resolve, reset } = useMentions(directory)

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
      .insert({
        author_id: profile.id,
        body: body.trim(),
        media,
        event_id: eventId ?? null,
        mentions: resolve(body),
      })

    if (insertError) {
      // The row failed, so the objects it would have pointed at are orphans.
      await removeMedia(media.map((m) => m.path))
      setBusy(false)
      setError(errorMessage(insertError))
      return
    }

    setBody('')
    setFiles([])
    reset()
    if (fileInput.current) fileInput.current.value = ''
    setBusy(false)
    await onPosted()
  }

  return (
    <Panel className="px-5 py-5">
      <form onSubmit={submit} className="space-y-4">
        <div className="relative">
          <Textarea
            ref={bodyRef as React.RefObject<HTMLTextAreaElement>}
            rows={3}
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
              setCaret(e.target.selectionStart ?? 0)
            }}
            onKeyUp={sync}
            onClick={sync}
            maxLength={5000}
            placeholder={
              eventId
                ? 'Say something about this event. Use @ to tag someone.'
                : `What's on your mind, ${profile?.full_name.split(' ')[0] ?? 'friend'}? Use @ to tag someone.`
            }
          />
          <MentionPicker
            value={body}
            caret={caret}
            people={people}
            onPick={(person, from, query) => {
              const next = applyMention(body, person, from, query)
              setBody(next.text)
              setCaret(next.caret)
              setMentioned([...mentioned, person.id])
              requestAnimationFrame(() => {
                bodyRef.current?.focus()
                bodyRef.current?.setSelectionRange(next.caret, next.caret)
              })
            }}
          />
        </div>

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
  const {
    ref: draftRef,
    caret: draftCaret,
    setCaret: setDraftCaret,
    sync: syncDraft,
  } = useCaret()
  const {
    mentioned: draftMentions,
    setMentioned: setDraftMentions,
    people: commentPeople,
    resolve: resolveComment,
    reset: resetComment,
  } = useMentions(directory)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Nothing is destroyed on a single tap — those buttons sit under a thumb.
  const [confirming, setConfirming] = useState<
    { kind: 'post' } | { kind: 'comment'; id: string } | null
  >(null)

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
      .insert({
        post_id: post.id,
        author_id: profile.id,
        body: draft.trim(),
        mentions: resolveComment(draft),
      })
      .select()
      .single()

    setBusy(false)
    if (insertError) {
      setError(errorMessage(insertError))
      return
    }
    setDraft('')
    resetComment()
    onCommentAdded(data as PostComment)
  }

  async function removeComment(id: string) {
    setConfirming(null)
    const { error: deleteError } = await supabase.from('post_comments').delete().eq('id', id)
    if (deleteError) {
      setError(errorMessage(deleteError))
      return
    }
    onCommentRemoved(id)
  }

  async function deletePost() {
    setConfirming(null)
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
    <Panel id={`post-${post.id}`} className="px-5 py-5">
      <header className="flex items-start gap-3">
        <Initials
          name={author?.full_name ?? '?'}
          url={author?.avatar_path ? mediaUrls[author.avatar_path] : undefined}
          role={author?.role}
        />
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
            {author?.current_profession ? `${author.current_profession} · ` : ''}
            {formatDate(post.created_at)}
          </div>
        </div>
        {canModerate && (
          <button
            type="button"
            onClick={() => setConfirming({ kind: 'post' })}
            className="shrink-0 text-xs text-dim transition-colors hover:text-red-400"
          >
            Delete
          </button>
        )}
      </header>

      {post.body && (
        <p className="mt-4 text-sm leading-relaxed whitespace-pre-wrap text-fg">
          <MentionText
            body={post.body}
            mentions={post.mentions}
            directory={directory}
            onOpen={onViewMember}
          />
        </p>
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
                preload="metadata"
                className="aspect-video w-full rounded-sm border border-line bg-fg/[0.03]"
              />
            ) : (
              <img
                key={item.path}
                src={mediaUrls[item.path]}
                alt=""
                loading="lazy"
                className="aspect-[4/3] w-full rounded-sm border border-line bg-fg/[0.03] object-cover"
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
                <span className="min-w-0 flex-1 break-words text-muted">
                  <MentionText
                    body={comment.body}
                    mentions={comment.mentions}
                    directory={directory}
                    onOpen={onViewMember}
                  />
                </span>
                {removable && (
                  <button
                    type="button"
                    onClick={() => setConfirming({ kind: 'comment', id: comment.id })}
                    className="shrink-0 text-xs text-dim transition hover:text-red-400 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
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

      <ConfirmModal
        open={confirming !== null}
        title={confirming?.kind === 'comment' ? 'Delete this comment?' : 'Delete this post?'}
        body={
          confirming?.kind === 'comment'
            ? 'The comment is removed for everyone. This cannot be undone.'
            : 'The post, its images, its likes and its comments all go. This cannot be undone.'
        }
        onConfirm={() =>
          confirming?.kind === 'comment' ? removeComment(confirming.id) : deletePost()
        }
        onClose={() => setConfirming(null)}
      />

      <form onSubmit={addComment} className="mt-3.5 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            ref={draftRef as React.RefObject<HTMLInputElement>}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setDraftCaret(e.target.selectionStart ?? 0)
            }}
            onKeyUp={syncDraft}
            onClick={syncDraft}
            maxLength={2000}
            placeholder="Add a comment. Use @ to tag someone."
            className="h-9 w-full rounded-sm border border-line bg-transparent px-3 text-sm text-fg placeholder:text-dim focus:border-gold focus:outline-none"
          />
          <MentionPicker
            value={draft}
            caret={draftCaret}
            people={commentPeople}
            onPick={(person, from, query) => {
              const next = applyMention(draft, person, from, query)
              setDraft(next.text)
              setDraftCaret(next.caret)
              setDraftMentions([...draftMentions, person.id])
              requestAnimationFrame(() => {
                draftRef.current?.focus()
                ;(draftRef.current as HTMLInputElement | null)?.setSelectionRange(
                  next.caret,
                  next.caret,
                )
              })
            }}
          />
        </div>
        <Button type="submit" size="sm" disabled={!draft.trim() || busy}>
          Reply
        </Button>
      </form>
    </Panel>
  )
}
