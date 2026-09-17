import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  EmptyState,
  Initials,
  Input,
  LoadFailed,
  Notice,
  Panel,
  SectionHeader,
  Spinner,
} from '../../components/ui'
import { useAuth } from '../../context/AuthProvider'
import { eventWhen, type FeedbackOutcome, type FeedbackQuestion } from '../../lib/events'
import { signMedia } from '../../lib/media'
import { errorMessage, loadFailed, supabase } from '../../lib/supabase'
import {
  anyAnswered,
  answerOf,
  EventForm,
  PeerForm,
  type Answer,
  type Draft,
} from './feedback/FeedbackForms'
import { EventShell } from './shared'

/**
 * Feedback, after an event.
 *
 * Two different things share this screen because they are one job in the
 * respondent's head: say something about the people you met, and say
 * something about the evening. They are stored separately — `peer_feedback`
 * is about a person, `event_feedback` is about an event — and they open and
 * close independently.
 *
 * The rule that shapes everything here is FDB-09: submitted feedback is never
 * rendered to anybody but an administrator. Not the author's own words back
 * to them, not a summary, not a count of how somebody was rated, not in the
 * confirmation. So there is no "what I said" screen and no "reviews about me"
 * screen, and `my_feedback_progress` — which returns outcomes and never
 * answer text — is deliberately the only thing this page reads about work
 * already done.
 */

/** The event as the public view hands it over. Slug in, feedback window out. */
interface FeedbackEvent {
  id: string
  title: string
  slug: string
  status: string
  starts_at: string
  ends_at: string | null
  timezone: string
  feedback_opens_after_minutes: number
}

interface ProgressRow {
  /** Null on the one row that carries the event-level form's state. */
  subject_id: string | null
  subject_name: string | null
  outcome: FeedbackOutcome
}

const OUTCOME_WORDS: Record<FeedbackOutcome, string> = {
  pending: 'Not started',
  skipped: 'Left blank',
  did_not_meet: 'Did not meet',
  submitted: 'Sent',
}

/** QLT-04. Never the tick alone — the word carries it. */
const OUTCOME_TONE: Record<FeedbackOutcome, string> = {
  pending: 'text-dim',
  skipped: 'text-muted',
  did_not_meet: 'text-muted',
  submitted: 'text-positive',
}

/**
 * QLT-03, FDB-07. Drafts survive the tab, not just the component.
 *
 * FDB-07 opens with "make the feedback flow easy to use on a phone", and the
 * way this actually fails on a phone is not an error at all: somebody works
 * through eight of their twelve people at a dinner, locks the screen, and the
 * mobile browser discards the tab to reclaim memory. Keeping drafts only in
 * React state loses every word of that, and no error was ever shown because
 * nothing went wrong.
 *
 * `sessionStorage` rather than `localStorage`, for the reason signupResume
 * gives: this belongs to one sitting. A half-written opinion about a named
 * person, left on a shared laptop until next week, is not a small thing.
 *
 * Scoped to event *and* author, so signing out and back in as somebody else
 * never hands them a stranger's unsent words.
 */
interface StoredDrafts {
  peers: Record<string, Draft>
  event: Draft
}

function draftKey(eventId: string, authorId: string): string {
  return `amazing:feedback-drafts:${eventId}:${authorId}`
}

/*
 * Every read and write is wrapped. Storage throws outright in private mode and
 * in some embedded webviews — a form that crashed because it could not save a
 * draft would be a worse bug than the lost work it was trying to prevent.
 */
function readDrafts(key: string): StoredDrafts | null {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as StoredDrafts) : null
  } catch {
    return null
  }
}

function writeDrafts(key: string, drafts: StoredDrafts): void {
  try {
    // Nothing left to keep: take the entry away rather than leaving an empty
    // husk behind for the next person on this device to inherit.
    if (!Object.keys(drafts.peers).length && !Object.keys(drafts.event).length) {
      sessionStorage.removeItem(key)
      return
    }
    sessionStorage.setItem(key, JSON.stringify(drafts))
  } catch {
    // As above.
  }
}

export default function Feedback() {
  const { slug = '' } = useParams()
  const { session, profile, loading: authLoading } = useAuth()
  const me = profile?.id ?? null

  const [event, setEvent] = useState<FeedbackEvent | null>(null)
  const [questions, setQuestions] = useState<FeedbackQuestion[]>([])
  const [progress, setProgress] = useState<ProgressRow[]>([])
  const [avatars, setAvatars] = useState<Record<string, string>>({})
  const [attended, setAttended] = useState<boolean | null>(null)

  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [missing, setMissing] = useState(false)

  /** Every draft on the page, kept while the person moves between people. */
  const [peerDrafts, setPeerDrafts] = useState<Record<string, Draft>>({})
  const [eventDraft, setEventDraft] = useState<Draft>({})
  const [selected, setSelected] = useState<string | null>(null)
  /** FDB-04. Narrows the peer list by name. Empty until somebody types. */
  const [peerQuery, setPeerQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [justSent, setJustSent] = useState('')

  /**
   * QLT-01. Once this screen has had a session, losing it must not swap the
   * page out — that would throw away everything typed. The expiry is said in
   * a banner instead, and the answers stay on screen.
   */
  const hadSession = useRef(false)
  if (session) hadSession.current = true
  const expired = !session && hadSession.current

  const loadProgress = useCallback(async (eventId: string) => {
    const { data, error: progressError } = await supabase
      .from('my_feedback_progress')
      .select('subject_id, subject_name, outcome')
      .eq('event_id', eventId)
    if (progressError) throw progressError
    setProgress((data as ProgressRow[]) ?? [])
  }, [])

  const load = useCallback(async () => {
    setFailed(false)
    setMissing(false)

    // The public view, so the event's name is known before anybody signs in
    // and the sign-in prompt can say which event it is about.
    const { data: eventRow, error: eventError } = await supabase
      .from('event_public')
      .select('id, title, slug, status, starts_at, ends_at, timezone, feedback_opens_after_minutes')
      .eq('slug', slug)
      .maybeSingle()

    if (eventError) {
      loadFailed(eventError, 'this event')
      setFailed(true)
      setLoading(false)
      return
    }
    if (!eventRow) {
      setMissing(true)
      setLoading(false)
      return
    }

    const found = eventRow as FeedbackEvent
    setEvent(found)

    if (!me) {
      setLoading(false)
      return
    }

    try {
      // FDB-06. Attendance is the gate, and it is the database's answer, not
      // ours — a ticket, an invitation or an RSVP proves nothing about
      // whether somebody walked through the door (QLT-07).
      const { data: didAttend, error: attendError } = await supabase.rpc('attended_event', {
        p_event: found.id,
        p_profile: me,
      })
      if (attendError) throw attendError
      setAttended(Boolean(didAttend))

      if (!didAttend) {
        setLoading(false)
        return
      }

      const [questionsRes, peopleRes] = await Promise.all([
        supabase
          .from('feedback_questions')
          .select('*')
          .eq('active', true)
          .order('scope')
          .order('slot'),
        supabase
          .from('event_participants')
          .select('profile_id, avatar_path')
          .eq('event_id', found.id)
          .eq('attended', true),
      ])
      if (questionsRes.error) throw questionsRes.error
      if (peopleRes.error) throw peopleRes.error

      setQuestions((questionsRes.data as FeedbackQuestion[]) ?? [])
      await loadProgress(found.id)

      const paths = ((peopleRes.data as { avatar_path: string | null }[]) ?? [])
        .map((p) => p.avatar_path)
        .filter((p): p is string => Boolean(p))
      const byProfile = Object.fromEntries(
        ((peopleRes.data as { profile_id: string; avatar_path: string | null }[]) ?? []).map(
          (p) => [p.profile_id, p.avatar_path],
        ),
      )
      if (paths.length) {
        try {
          const signed = await signMedia(paths)
          setAvatars(
            Object.fromEntries(
              Object.entries(byProfile)
                .filter(([, path]) => path && signed[path])
                .map(([id, path]) => [id, signed[path as string]]),
            ),
          )
        } catch {
          // A picture that will not sign is not worth failing a page over;
          // Initials covers everybody who has none anyway.
          setAvatars({})
        }
      }
    } catch (loadError) {
      loadFailed(loadError, 'your feedback')
      setFailed(true)
    }

    setLoading(false)
  }, [slug, me, loadProgress])

  useEffect(() => {
    if (authLoading) return
    void load()
  }, [authLoading, load])

  const peerQuestions = useMemo(
    () => questions.filter((q) => q.scope === 'peer'),
    [questions],
  )
  const eventQuestions = useMemo(
    () => questions.filter((q) => q.scope === 'event'),
    [questions],
  )

  /** Everyone but me. FDB-06 — nobody reviews themselves. */
  const peers = useMemo(
    () =>
      progress
        .filter((row): row is ProgressRow & { subject_id: string } => row.subject_id !== null)
        .filter((row) => row.subject_id !== me)
        .sort((a, b) => (a.subject_name ?? '').localeCompare(b.subject_name ?? '')),
    [progress, me],
  )

  /**
   * FDB-04: "make it practical to find people in larger events". A dinner for
   * twelve is a list you read; sixty people is sixty rows of scrolling to find
   * the one person you actually want to write about, on a phone, which is
   * where FDB-07 says this has to work.
   *
   * The search appears only once the list is long enough to need it —
   * a search box above eight names is clutter offering to solve nothing.
   * Matching is case- and accent-insensitive so "jose" finds "José"; the
   * counts above stay counts of everybody, because "3 of 60 done" is the true
   * figure whether or not a filter is applied.
   */
  const SEARCH_FROM = 8
  const shownPeers = useMemo(() => {
    const q = peerQuery.trim().toLocaleLowerCase()
    if (!q) return peers
    const fold = (v: string) => v.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase()
    return peers.filter((p) => fold(p.subject_name ?? '').includes(fold(q)))
  }, [peers, peerQuery])

  const eventOutcome =
    progress.find((row) => row.subject_id === null)?.outcome ?? 'pending'

  /* ---- drafts that outlive the tab -------------------------------------- */

  const storageKey = event && me ? draftKey(event.id, me) : null

  // Hydrate once the event and the author are both known, and replace rather
  // than merge. The key carries the event id, and this route re-renders
  // instead of remounting when the slug changes — so keeping whatever was in
  // state would carry one event's half-written opinions about people onto a
  // different event's form, and then save them there.
  useEffect(() => {
    if (!storageKey) return
    const saved = readDrafts(storageKey)
    setPeerDrafts(saved?.peers ?? {})
    setEventDraft(saved?.event ?? {})
  }, [storageKey])

  // And mirror every change back. A successful submit already clears the
  // draft from state, so this writes the cleared version without needing a
  // second code path to remember — there is no way for the two to disagree.
  useEffect(() => {
    if (!storageKey) return
    writeDrafts(storageKey, { peers: peerDrafts, event: eventDraft })
  }, [storageKey, peerDrafts, eventDraft])

  const done = peers.filter((p) => p.outcome !== 'pending').length

  function setPeerAnswer(subjectId: string, questionId: string, next: Answer) {
    setPeerDrafts((drafts) => ({
      ...drafts,
      [subjectId]: { ...(drafts[subjectId] ?? {}), [questionId]: next },
    }))
    setError('')
  }

  /**
   * QLT-03. Nothing here clears a draft on failure. If the write does not
   * land, the words stay on screen and the button says so — retyping three
   * paragraphs because a train went into a tunnel is how people stop
   * answering at all.
   */
  async function writeOutcome(subjectId: string, outcome: FeedbackOutcome) {
    const { error: outcomeError } = await supabase.from('feedback_subjects').upsert(
      { event_id: event!.id, author_id: me!, subject_id: subjectId, outcome },
      { onConflict: 'event_id,author_id,subject_id' },
    )
    if (outcomeError) throw outcomeError
  }

  async function submitPeer(subjectId: string) {
    if (!event || !me) return
    setBusy(true)
    setError('')

    const draft = peerDrafts[subjectId] ?? {}
    const answered = anyAnswered(draft, peerQuestions)
    const now = new Date().toISOString()

    try {
      const rows = peerQuestions
        .filter((q) => {
          const answer = answerOf(draft, q.id)
          return Boolean(answer.text.trim() || answer.choice)
        })
        .map((q) => {
          const answer = answerOf(draft, q.id)
          return {
            event_id: event.id,
            author_id: me,
            subject_id: subjectId,
            question_id: q.id,
            answer_text: answer.text.trim() || null,
            answer_choice: answer.choice,
            submitted_at: now,
          }
        })

      // Answers first, then the outcome. Upserted on the natural key, so a
      // double tap or a retry after a timeout overwrites rather than adding
      // a second review of the same person (FDB-07).
      if (rows.length) {
        const { error: writeError } = await supabase
          .from('peer_feedback')
          .upsert(rows, { onConflict: 'event_id,author_id,subject_id,question_id' })
        if (writeError) throw writeError
      }

      // Three different facts, three different outcomes: they answered, they
      // had nothing to add, or they never met them (FDB-05).
      await writeOutcome(subjectId, answered ? 'submitted' : 'skipped')
      await loadProgress(event.id)

      setPeerDrafts((drafts) => {
        const next = { ...drafts }
        delete next[subjectId]
        return next
      })
      setSelected(null)
      // FDB-12/13. Confirm that it was sent, and say nothing at all about
      // what was in it.
      setJustSent(answered ? 'Sent. Thank you.' : 'Noted — left blank.')
    } catch (submitError) {
      setError(submitFailure(submitError, session !== null))
    }
    setBusy(false)
  }

  async function didNotMeet(subjectId: string) {
    if (!event || !me) return
    setBusy(true)
    setError('')
    try {
      await writeOutcome(subjectId, 'did_not_meet')
      await loadProgress(event.id)
      setSelected(null)
      setJustSent('Noted. We will not ask about them again.')
    } catch (submitError) {
      setError(submitFailure(submitError, session !== null))
    }
    setBusy(false)
  }

  async function submitEvent() {
    if (!event || !me) return
    setBusy(true)
    setError('')
    const now = new Date().toISOString()

    try {
      const rows = eventQuestions
        .filter((q) => {
          const answer = answerOf(eventDraft, q.id)
          return Boolean(answer.text.trim() || answer.scale !== null)
        })
        .map((q) => {
          const answer = answerOf(eventDraft, q.id)
          return {
            event_id: event.id,
            author_id: me,
            question_id: q.id,
            answer_scale: answer.scale,
            answer_text: answer.text.trim() || null,
            submitted_at: now,
          }
        })

      const { error: writeError } = await supabase
        .from('event_feedback')
        .upsert(rows, { onConflict: 'event_id,author_id,question_id' })
      if (writeError) throw writeError

      await loadProgress(event.id)
      setEventDraft({})
      setJustSent('Sent. Thank you.')
    } catch (submitError) {
      setError(submitFailure(submitError, session !== null))
    }
    setBusy(false)
  }

  /* ---- gates ------------------------------------------------------------ */

  if (authLoading || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-dim">
        <Spinner />
      </div>
    )
  }

  if (failed) {
    return (
      <Shell>
        <LoadFailed what="this feedback form" onRetry={() => void load()} />
      </Shell>
    )
  }

  if (missing || !event) {
    return (
      <Shell>
        <Panel className="px-6 py-10 text-center">
          <h1 className="display text-2xl">We can't find that event</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            The link may be old, or the event may have been removed.
          </p>
        </Panel>
      </Shell>
    )
  }

  // QLT-01. `!session` alone was wrong, and it defeated the guard twenty lines
  // above it: somebody six answers into reviewing three people whose token
  // lapsed had this branch replace the whole page, losing every answer — the
  // exact thing `expired` and its banner exist to prevent, and which they could
  // never prevent because this test always won the race. Only somebody who
  // never had a session is sent to sign in; somebody who *lost* one keeps their
  // answers on screen and gets the banner instead.
  if (!session && !hadSession.current) {
    return (
      <Shell>
        <Panel className="px-6 py-10">
          <h1 className="display text-2xl">Sign in to leave your feedback</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Your feedback on <strong className="text-fg">{event.title}</strong> is tied to
            your account, so we need to know it is you. We will bring you straight back here.
          </p>
          <div className="mt-6">
            {/* FDB-03. "Straight back here" is a promise the address has to
                carry — SignIn reads `next`. It used to be written to
                sessionStorage under a key nothing ever read, so the sentence
                above was simply untrue. One mechanism, not two. */}
            <Link
              to={`/signin?next=${encodeURIComponent(`/events/feedback/${slug}`)}`}
              className="inline-flex h-11 items-center justify-center rounded-[4px] border border-fg bg-fg px-5 text-sm font-medium text-white transition-colors hover:bg-[#2c514b]"
            >
              Sign in
            </Link>
          </div>
        </Panel>
      </Shell>
    )
  }

  const ended = new Date(event.ends_at ?? event.starts_at).getTime()
  const opensAt = ended + event.feedback_opens_after_minutes * 60_000

  if (event.status === 'cancelled') {
    return (
      <Shell>
        <Ineligible
          title="This event was cancelled"
          body="There is no feedback to give, and nobody is expecting any from you."
        />
      </Shell>
    )
  }

  // FDB-15. The window is the organiser's to set, so say when rather than
  // showing a form that will refuse.
  if (Date.now() < opensAt) {
    return (
      <Shell>
        <Ineligible
          title="Feedback isn't open yet"
          body={
            Date.now() < ended
              ? `${event.title} hasn't happened yet. It runs ${eventWhen(event)}.`
              : `Feedback opens shortly after the event finishes — from ${new Date(
                  opensAt,
                ).toLocaleString(undefined, {
                  weekday: 'long',
                  hour: 'numeric',
                  minute: '2-digit',
                })}.`
          }
        />
      </Shell>
    )
  }

  if (attended === false) {
    return (
      <Shell>
        <Ineligible
          title="Feedback is for people who came"
          body={
            'We have no record of you being checked in at this event, so this form stays ' +
            'closed. Holding a ticket, being invited or saying you were coming is not the ' +
            'same thing. If you were there and were never scanned at the door, ask one of ' +
            'the hosts to add you — they can, and the form opens as soon as they do.'
          }
        />
      </Shell>
    )
  }

  /* ---- the form --------------------------------------------------------- */

  const selectedPeer = peers.find((p) => p.subject_id === selected) ?? null

  return (
    <Shell>
      <div className="mb-6">
        <div className="eyebrow">Feedback</div>
        <h1 className="display mt-2 text-3xl">{event.title}</h1>
      </div>

      {expired && (
        <div className="mb-5">
          <Notice tone="error">
            Your sign-in has expired. Open Amazing in another tab and sign in, then send
            again — nothing you have typed here has been lost.
          </Notice>
        </div>
      )}

      <div aria-live="polite">
        {justSent && !selectedPeer && (
          <div className="mb-5">
            <Notice tone="success">{justSent}</Notice>
          </div>
        )}
      </div>

      {selectedPeer ? (
        <section>
          <div className="mb-5 flex items-center gap-3">
            <Initials
              name={selectedPeer.subject_name ?? 'Someone who was there'}
              url={avatars[selectedPeer.subject_id]}
              size="lg"
            />
            <div className="min-w-0">
              <h2 className="text-lg text-fg">
                {selectedPeer.subject_name ?? 'Someone who was there'}
              </h2>
              <p className="text-xs text-dim">Three questions, all optional.</p>
            </div>
          </div>

          {/*
            An answer is never final. FDB-07 forbids duplicate reviews, which
            the unique constraint already guarantees — it does not make a
            mis-tap permanent. Somebody who catches "No" on the meet-again
            question when they meant "Yes" has otherwise put a false negative
            about a real person in front of an administrator for good.

            Saying so costs a sentence, and it has to be said, because FDB-09
            means we cannot show them what they wrote — not even their own
            words. So a revision starts from a blank form, and a question they
            leave blank keeps its previous answer rather than being cleared.
            That is surprising unless it is stated plainly.
          */}
          {selectedPeer.outcome !== 'pending' && (
            <div className="mb-5 rounded-[6px] border border-line bg-raised px-4 py-3">
              <p className="text-xs leading-relaxed text-muted">
                {selectedPeer.outcome === 'did_not_meet'
                  ? 'You said you did not meet this person. You can change that by answering below.'
                  : selectedPeer.outcome === 'skipped'
                    ? 'You left this blank last time. Anything you write now will be sent.'
                    : 'You have already sent feedback about this person, and you can change it. ' +
                      'Only Amazing administrators can read what you wrote, so we cannot show it ' +
                      'back to you here — anything you write now replaces your answer to that ' +
                      'question, and a question you leave blank keeps the answer you gave before.'}
              </p>
            </div>
          )}

          <PeerForm
            questions={peerQuestions}
            draft={peerDrafts[selectedPeer.subject_id] ?? {}}
            busy={busy}
            error={error}
            onChange={(questionId, next) =>
              setPeerAnswer(selectedPeer.subject_id, questionId, next)
            }
            onSubmit={() => void submitPeer(selectedPeer.subject_id)}
            onDidNotMeet={() => void didNotMeet(selectedPeer.subject_id)}
            onBack={() => {
              setSelected(null)
              setError('')
            }}
          />
        </section>
      ) : (
        <div className="space-y-10">
          <section>
            <SectionHeader
              title="The people you met"
              caption={
                peers.length === 0
                  ? undefined
                  : done === peers.length
                    ? // Nothing here is final — reopening somebody and sending
                      // again overwrites, it does not add a second review.
                      `All ${peers.length} done. You can stop, or open anyone again to change what you sent.`
                    : `${done} of ${peers.length} done. You can stop and come back.`
              }
            />

            {/* FDB-04. Only once the list is long enough to be a problem. */}
            {peers.length >= SEARCH_FROM && (
              <div className="mb-4">
                <Input
                  value={peerQuery}
                  onChange={(e) => setPeerQuery(e.target.value)}
                  placeholder="Search by name"
                  aria-label="Search the people you met by name"
                />
              </div>
            )}

            {peers.length === 0 ? (
              <EmptyState>
                Nobody else has been checked in at this event yet, so there is nobody to
                write about. That is not the same as nobody having come — if check-in was
                not finished on the door, a host can still put it right.
              </EmptyState>
            ) : shownPeers.length === 0 ? (
              // QLT-02. An empty filter is not an empty event, and saying so
              // stops it reading as "they were not there".
              <EmptyState>
                Nobody at this event matches &ldquo;{peerQuery.trim()}&rdquo;. Clear the search
                to see all {peers.length}.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line rounded-[6px] border border-line bg-white">
                {shownPeers.map((peer) => {
                  const draft = peerDrafts[peer.subject_id] ?? {}
                  const unsent =
                    peer.outcome === 'pending' && anyAnswered(draft, peerQuestions)
                  return (
                    <li key={peer.subject_id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(peer.subject_id)
                          setJustSent('')
                          setError('')
                        }}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised"
                      >
                        <Initials
                          name={peer.subject_name ?? 'Someone who was there'}
                          url={avatars[peer.subject_id]}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">
                          {peer.subject_name ?? 'Someone who was there'}
                        </span>
                        {/* Unsent work and sent work must not look alike. */}
                        <span
                          className={`shrink-0 text-xs ${
                            unsent ? 'text-gold' : OUTCOME_TONE[peer.outcome]
                          }`}
                        >
                          {unsent ? 'Started, not sent' : OUTCOME_WORDS[peer.outcome]}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

            {/*
              ATT-06: "a missing check-in alone should not be presented as a
              definite no-show if check-in was incomplete". This list is built
              from check-ins, and a door on a busy night is not a census —
              somebody plainly there can be missing from it. Leaving that
              unsaid invites the reader to conclude they never came, which is
              the inference the requirement forbids. FDB-06 gives the way out,
              so we name it: a correction reopens both this list and that
              person's own form.
            */}
            <p className="mt-3 text-xs leading-relaxed text-dim">
              Only people checked in at the door are here. If someone you met is missing,
              their check-in was probably missed rather than skipped — ask a host to correct
              it and they will appear.
            </p>
          </section>

          <section>
            <SectionHeader
              title="The event itself"
              caption="Two questions about the evening rather than the people."
            />

            {eventOutcome === 'submitted' ? (
              // FDB-12/13. Confirmation and nothing else: no score read back,
              // no summary, no "you said".
              <Panel className="px-5 py-6">
                <p className="text-sm text-fg">You have sent your feedback on this event.</p>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  It is with Amazing's administrators. Thank you.
                </p>
              </Panel>
            ) : (
              <EventForm
                questions={eventQuestions}
                draft={eventDraft}
                busy={busy}
                error={error}
                onChange={(questionId, next) => {
                  setEventDraft((d) => ({ ...d, [questionId]: next }))
                  setError('')
                }}
                onSubmit={() => void submitEvent()}
              />
            )}
          </section>
        </div>
      )}

      <p className="mt-12 pb-10 text-center text-xs text-dim">
        <Link to="/events/mine" className="transition-colors hover:text-fg">
          Back to your events
        </Link>
      </p>
    </Shell>
  )
}

/* -------------------------------------------------------------------------- */
/* Small pieces                                                                */
/* -------------------------------------------------------------------------- */

/**
 * FDB-03. Feedback is the last step of the attendee journey, so it wears the
 * same frame as the four screens before it rather than a bare page of its own
 * — which left whoever followed the emailed link with no way onwards but the
 * browser's back button. EventShell carries the app nav for a signed-in
 * respondent and the public header for anybody else, and this screen is
 * always one of the two.
 *
 * The column stays narrow: these are questions to answer one at a time, not a
 * page to scan.
 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <EventShell>
      <div className="mx-auto max-w-2xl">{children}</div>
    </EventShell>
  )
}

/** QLT-02. Whenever the form is closed, the screen says exactly why. */
function Ineligible({ title, body }: { title: string; body: string }) {
  return (
    <Panel className="px-6 py-10">
      <h1 className="display text-2xl">{title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">{body}</p>
      <div className="mt-7">
        <Link to="/events/mine" className="text-sm text-gold transition-colors hover:text-fg">
          Your events
        </Link>
      </div>
    </Panel>
  )
}

/**
 * A failed write, said in words the respondent can act on.
 *
 * The important half is the promise at the end: their answers are still on
 * screen, so "try again" is a button rather than a retyping exercise
 * (QLT-03).
 */
function submitFailure(error: unknown, signedIn: boolean): string {
  if (!signedIn) {
    return 'Your sign-in expired before this could be sent. Sign in again and press send — your answers are still here.'
  }
  return `We could not send that. ${errorMessage(error)} Your answers are still here — try again.`
}
