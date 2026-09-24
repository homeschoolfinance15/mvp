import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, Field, Input, Notice, Panel, Spinner } from '../../components/ui'
import { useLive } from '../../lib/live'
import { supabase } from '../../lib/supabase'
import type { CheckInResult, EventAttendance } from '../../lib/events'
import { outsideEventDay } from './rules'
import { ManagedEventGate, ManageShell, useManagedEvent } from './shared'

/**
 * The door.
 *
 * This screen is held in one hand, at night, by someone who is also greeting
 * people. Everything here is sized for that: one enormous answer at a time,
 * a running count, and a way to type a code when the camera will not play.
 *
 * ATT-02 is the whole screen. Five things can happen when a ticket is
 * presented and they must not be confusable — the difference between "already
 * checked in" and "this ticket is cancelled" is the difference between waving
 * somebody through and turning them away. Each outcome gets its own words,
 * its own colour and its own instruction to the person holding the phone
 * (QLT-04: never colour alone).
 */

/* -------------------------------------------------------------------------- */
/* Scanning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The browser's own barcode reader.
 *
 * Chrome and Edge on Android, and Chrome on ChromeOS and macOS, ship the
 * Shape Detection API, which is where this screen will actually be used — a
 * phone at a venue door. Safari and Firefox do not implement it at all, and
 * desktop Chrome on Windows and Linux is inconsistent about it. So this is
 * feature-detected twice: the constructor has to exist *and* it has to admit
 * to supporting QR, because an implementation that only reads one-dimensional
 * barcodes would parse nothing and look broken.
 *
 * ponytail: no scanner library. A dependency that ships a WASM decoder costs
 * more than the typed fallback below, which every device already supports.
 * Revisit only if enough venues turn out to run iPhones on Safari.
 */
interface DetectedBarcode {
  rawValue: string
}

interface BarcodeReader {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}

interface BarcodeReaderConstructor {
  new (options?: { formats?: string[] }): BarcodeReader
  getSupportedFormats(): Promise<string[]>
}

function barcodeReaderConstructor(): BarcodeReaderConstructor | null {
  const found = (window as unknown as { BarcodeDetector?: BarcodeReaderConstructor })
    .BarcodeDetector
  return typeof found === 'function' ? found : null
}

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The database's five results, plus the one it cannot report: the request
 * never came back. QLT-10 — a slow tunnel at a basement venue must never
 * render a success that did not happen, so "we do not know" is a first-class
 * outcome with its own words rather than an error that looks like a refusal.
 */
type Outcome = CheckInResult | 'unreachable' | 'refused'

interface OutcomeStyle {
  headline: string
  /** What the person holding the phone should do about it. */
  instruction: string
  frame: string
  badge: string
}

const OUTCOMES: Record<Outcome, OutcomeStyle> = {
  ok: {
    headline: 'Checked in',
    instruction: 'Welcome them in.',
    frame: 'border-[#b9d8c4] bg-[#dcf0e4]',
    badge: 'text-positive',
  },
  // ATT-03. A second scan — a second door, a second phone, somebody scanning
  // twice because the first beep was missed — is the system working, not a
  // failure. It gets the calm gold of "have a look", never red.
  already: {
    headline: 'Already checked in',
    instruction: 'Let them in. They are counted once.',
    frame: 'border-[#efc98f] bg-[#f6ecd9]',
    badge: 'text-[#8a4b00]',
  },
  wrong_event: {
    headline: 'Wrong event',
    instruction: 'This is a real ticket for a different event. Do not admit them on it.',
    frame: 'border-[#e6b5ad] bg-[#fff0ec]',
    badge: 'text-negative',
  },
  invalid: {
    headline: 'Not a valid ticket',
    instruction: 'Nothing matches this code. Ask them to open their ticket again.',
    frame: 'border-[#e6b5ad] bg-[#fff0ec]',
    badge: 'text-negative',
  },
  cancelled: {
    headline: 'Ticket cancelled',
    instruction:
      'This booking or the event was cancelled, or the ticket was replaced. Send them to a host.',
    frame: 'border-[#e6b5ad] bg-[#fff0ec]',
    badge: 'text-negative',
  },
  unreachable: {
    headline: 'Not sent',
    instruction:
      'We could not reach the server, so nothing here is confirmed either way. ' +
      'Scan again when you have signal — scanning twice never counts anybody twice.',
    frame: 'border-line-strong bg-raised',
    badge: 'text-muted',
  },
  // ATT-02. The database answered, and the answer was no — a steward who is
  // not a host, or a session that ran out. Its own sentence replaces this
  // instruction, because "scan again when you have signal" would be a lie.
  refused: {
    headline: 'Not checked',
    instruction: 'This phone is not allowed to check people in. Ask a host.',
    frame: 'border-[#e6b5ad] bg-[#fff0ec]',
    badge: 'text-negative',
  },
}

interface Shown {
  outcome: Outcome
  /** The database's own words, when it refused rather than answered. */
  message?: string
  /** Only known once the ticket has been traced back to a person. */
  name?: string
  attendance?: Pick<EventAttendance, 'recorded_at' | 'recorded_by' | 'corrected'>
  recordedByName?: string
}

function arrivalSentence(shown: Shown): string | null {
  if (!shown.attendance) return null
  const at = new Date(shown.attendance.recorded_at).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  const by = shown.recordedByName ? ` by ${shown.recordedByName}` : ''
  // ATT-06. A correction is preserved as a correction: we do not describe a
  // host ticking somebody off a list as a scan that never happened.
  return shown.attendance.corrected
    ? `Marked as attended${by} at ${at}, after the fact rather than scanned.`
    : `Arrived at ${at}${by}.`
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

export default function CheckIn() {
  const { id = '' } = useParams()

  // EML-09. The same load and the same host check as every other organiser
  // screen, so a steward who is not a host is told so rather than handed a
  // scanner that refuses every ticket.
  const { result, reload } = useManagedEvent(id)
  const event = result.state === 'ready' ? result.data.event : null
  const [attendance, setAttendance] = useState<EventAttendance[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [expected, setExpected] = useState<number | null>(null)
  /**
   * ATT-02 treats "a temporary service problem" as its own answer rather
   * than a silence, and the roster deserves the same. A live refresh that
   * fails leaves the tally on screen looking current, and a steward reading
   * "18 / 30" has no way to know it stopped counting — at a door that is the
   * number they act on. Not an error banner: the door is the wrong place to
   * shout, and the previous figure is still the best one available.
   */
  const [rosterStale, setRosterStale] = useState(false)

  const [shown, setShown] = useState<Shown | null>(null)
  const [busy, setBusy] = useState(false)
  const [typed, setTyped] = useState('')

  const [camera, setCamera] = useState<'idle' | 'starting' | 'running' | 'unsupported' | 'refused'>(
    'idle',
  )
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  /**
   * One request at a time, and one arrival per code.
   *
   * A camera hands us the same QR forty times a second. Without both guards a
   * single ticket fires a burst of concurrent check_in calls, and while the
   * database would still record one arrival (ATT-03), the screen would flicker
   * between "checked in" and "already checked in" — which is exactly the
   * confusion ATT-02 exists to prevent.
   */
  const inFlight = useRef(false)
  const lastCode = useRef<{ code: string; at: number } | null>(null)

  /** Everyone who has arrived, with the names to say it out loud. */
  const refreshRoster = useCallback(async () => {
    const [arrivals, people, confirmed] = await Promise.all([
      supabase.from('event_attendance').select('*').eq('event_id', id),
      supabase.from('event_participants').select('profile_id, full_name').eq('event_id', id),
      supabase
        .from('event_registrations')
        .select('*', { count: 'exact', head: true })
        .eq('event_id', id)
        .eq('status', 'confirmed'),
    ])

    if (arrivals.data) setAttendance(arrivals.data as EventAttendance[])
    if (people.data) {
      setNames(
        Object.fromEntries(
          (people.data as { profile_id: string; full_name: string }[]).map((p) => [
            p.profile_id,
            p.full_name,
          ]),
        ),
      )
    }
    if (typeof confirmed.count === 'number') setExpected(confirmed.count)

    // Each read is allowed to fail on its own — a flaky phone at a venue
    // door loses one of three as easily as all three — so the flag is set
    // from any of them and cleared only when the whole roster came back.
    setRosterStale(Boolean(arrivals.error || people.error || confirmed.error))
  }, [id])

  const ready = result.state === 'ready'
  useEffect(() => {
    if (ready) void refreshRoster()
  }, [ready, refreshRoster])

  /*
   * ATT-03. Two stewards on two phones are one door. Until now each saw only
   * their own scans, so the second one to meet a guest had a count that was
   * wrong and a roster that did not include the person standing in front of
   * them. Registrations are watched as well, because somebody can still buy a
   * ticket while the queue is moving and the expected count has to follow.
   *
   * This refreshes the roster rather than the whole screen, and it is not
   * suppressed while a scan is in flight: `refreshRoster` writes the arrivals,
   * the names and the count and touches neither the result panel nor the typed
   * code nor the camera, so there is nothing here for it to interrupt. Holding
   * it back during a scan would silence it at precisely the busiest moment at
   * the door, which is the moment ATT-03 is about.
   */
  useLive(['event_attendance', 'event_registrations'], () => void refreshRoster())

  /* ---- the scan itself -------------------------------------------------- */

  const present = useCallback(
    async (code: string) => {
      // Codes are stored lower-case, and check_in folds what it is given the
      // same way; the lookup below has to as well or the name never shows.
      const trimmed = code.trim().toLowerCase()
      if (!trimmed || inFlight.current) return

      const now = Date.now()
      const previous = lastCode.current
      // Four seconds is long enough for the camera to stop re-reading the QR
      // still in front of it, and short enough that a genuine re-scan (a
      // steward checking somebody twice on purpose) still answers.
      if (previous && previous.code === trimmed && now - previous.at < 4000) return
      lastCode.current = { code: trimmed, at: now }

      inFlight.current = true
      setBusy(true)
      setShown(null)

      const { data, error } = await supabase.rpc('check_in', {
        p_ticket_code: trimmed,
        p_event: id,
      })

      if (error) {
        // QLT-10. Two very different things arrive here: the network dropped,
        // or the database refused. Neither is a check-in, and neither may be
        // drawn as one. We cannot tell whether a dropped request landed, so
        // we say so — and the fact that a repeat scan is harmless is the
        // instruction, not a caveat.
        console.error('[amazing] check-in failed:', error)
        // P0001 is a raise in check_in itself: a refusal with a sentence, not
        // a lost request.
        setShown(
          error.code === 'P0001'
            ? { outcome: 'refused', message: error.message }
            : { outcome: 'unreachable' },
        )
        inFlight.current = false
        setBusy(false)
        return
      }

      const outcome = data as CheckInResult
      const next: Shown = { outcome }

      if (outcome === 'ok' || outcome === 'already') {
        // Whose ticket it is, then when they actually arrived. The ticket
        // lookup is separate because a host may have marked somebody attended
        // by hand (ATT-06), which leaves an attendance row with no ticket on
        // it — joining through the ticket would lose exactly that person.
        const { data: ticket } = await supabase
          .from('event_tickets')
          .select('profile_id')
          .eq('event_id', id)
          .eq('code', trimmed)
          .maybeSingle()

        const profileId = (ticket as { profile_id: string } | null)?.profile_id
        if (profileId) {
          const { data: row } = await supabase
            .from('event_attendance')
            .select('recorded_at, recorded_by, corrected')
            .eq('event_id', id)
            .eq('profile_id', profileId)
            .maybeSingle()

          next.name = names[profileId]
          next.attendance = (row as Shown['attendance']) ?? undefined
          if (row?.recorded_by) next.recordedByName = names[row.recorded_by]
        }
      }

      setShown(next)
      inFlight.current = false
      setBusy(false)
      if (outcome === 'ok') await refreshRoster()
    },
    [id, names, refreshRoster],
  )

  /* ---- camera ----------------------------------------------------------- */

  const startCamera = useCallback(async () => {
    const Reader = barcodeReaderConstructor()
    if (!Reader || !navigator.mediaDevices?.getUserMedia) {
      setCamera('unsupported')
      return
    }

    setCamera('starting')
    try {
      const formats = await Reader.getSupportedFormats()
      if (!formats.includes('qr_code')) {
        setCamera('unsupported')
        return
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        // The back camera, which is the one pointed at a ticket.
        video: { facingMode: 'environment' },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCamera('running')
    } catch (cameraError) {
      // A refusal and a missing camera land in the same place, and from the
      // door they mean the same thing: type the code instead.
      console.error('[amazing] camera unavailable:', cameraError)
      setCamera('refused')
    }
  }, [])

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  useEffect(() => {
    if (camera !== 'running') return
    const Reader = barcodeReaderConstructor()
    if (!Reader) return

    const reader = new Reader({ formats: ['qr_code'] })
    let stopped = false

    // Polling rather than every frame: a ticket is held still for a second or
    // more, and decoding at 60fps only warms the phone up.
    const timer = setInterval(async () => {
      const video = videoRef.current
      if (stopped || !video || video.readyState < 2 || inFlight.current) return
      try {
        const found = await reader.detect(video)
        if (found[0]?.rawValue) void present(found[0].rawValue)
      } catch {
        // A frame that will not decode is the normal case, not an error.
      }
    }, 400)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [camera, present])

  /* ---- render ----------------------------------------------------------- */

  if (!event) {
    return (
      <ManagedEventGate result={result} reload={reload}>
        {() => null}
      </ManagedEventGate>
    )
  }

  // ORG-5. A cancelled event admits nobody, and the database answers
  // "cancelled" for every ticket. Saying it once here beats a steward
  // discovering it one guest at a time.
  if (event.status === 'cancelled') {
    return (
      <ManageShell event={event}>
        <Notice tone="error">
          This event was cancelled. Nobody can be checked in.
        </Notice>
      </ManageShell>
    )
  }

  const arrived = attendance.length
  const style = shown ? OUTCOMES[shown.outcome] : null

  function onTypedSubmit(e: FormEvent) {
    e.preventDefault()
    const code = typed
    setTyped('')
    void present(code)
  }

  return (
    <div className="min-h-screen bg-ink">
      {/* Deliberately not the dashboard shell. At a door the whole screen is
          the answer, and a nav bar is one more thing to mis-tap. */}
      <header className="border-b border-line bg-white px-5 py-4">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="eyebrow">Check-in</div>
            <h1 className="mt-1 truncate text-sm font-medium text-fg">{event.title}</h1>
            {/* One way out, and only one. The nav bar stays off this screen for
                the reason above, but a steward who has finished at the door
                should not have to reach for the browser's back button to get
                to the rest of the event. */}
            <Link
              to={`/manage/events/${event.id}`}
              className="eyebrow mt-1 inline-block text-dim transition-colors hover:text-fg"
            >
              &#8592; Event
            </Link>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-2xl font-light tabular-nums text-fg">
              {arrived}
              <span className="text-dim">
                {expected === null ? '' : ` / ${expected}`}
              </span>
            </div>
            <div className="eyebrow mt-0.5">
              {expected === null ? 'Arrived' : 'Arrived of expected'}
            </div>
            {/* The tally is what a steward acts on, so it has to admit when it
                stopped counting. The word, not a colour (QLT-04), and the
                figure stays on screen because a moment-old count beats none. */}
            {rosterStale && (
              <div className="mt-1 text-[0.6875rem] text-[#8a4b00]">Not up to date</div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-6 px-5 pt-6 pb-10">
        {outsideEventDay(event.starts_at, event.ends_at, event.timezone) && (
          <Notice tone="warning">
            Today is not the day of this event. Check the ticket is for this event before letting
            anyone in — check-in still works.
          </Notice>
        )}
        {/* The answer, first and largest. aria-live so a screen reader gets it
            without the steward hunting for where it appeared. */}
        <div aria-live="assertive">
          {busy && (
            <Panel className="flex items-center gap-3 px-5 py-6 text-sm text-muted">
              <Spinner />
              Checking this ticket…
            </Panel>
          )}

          {!busy && shown && style && (
            <div className={`rounded-[6px] border px-5 py-6 ${style.frame}`}>
              <p className={`display text-3xl ${style.badge}`}>{style.headline}</p>
              {shown.name && <p className="mt-2 text-lg text-fg">{shown.name}</p>}
              {shown.outcome === 'already' && arrivalSentence(shown) && (
                <p className="mt-1 text-sm text-fg">{arrivalSentence(shown)}</p>
              )}
              <p className="mt-3 text-sm leading-relaxed text-muted">
                {shown.message ?? style.instruction}
              </p>
            </div>
          )}

          {!busy && !shown && (
            <Panel className="px-5 py-6 text-sm text-muted">
              Point the camera at a ticket, or type the code below.
            </Panel>
          )}
        </div>

        <Panel className="overflow-hidden">
          {camera === 'running' ? (
            <video
              ref={videoRef}
              muted
              playsInline
              // Nothing about a viewfinder is readable to a screen reader, and
              // the result above already announces itself.
              aria-hidden
              className="aspect-[4/3] w-full bg-fg object-cover"
            />
          ) : (
            <div className="px-5 py-6">
              {camera === 'idle' && (
                <>
                  <p className="text-sm text-muted">
                    Scanning uses your phone's camera and never leaves the device.
                  </p>
                  <Button variant="primary" className="mt-4" onClick={() => void startCamera()}>
                    Start the camera
                  </Button>
                </>
              )}

              {camera === 'starting' && (
                <p className="flex items-center gap-3 text-sm text-muted">
                  <Spinner />
                  Opening the camera…
                </p>
              )}

              {/* QLT-02. Say which of the two it is and what to do instead,
                  rather than showing a dead black rectangle. */}
              {camera === 'unsupported' && (
                <p className="text-sm leading-relaxed text-muted">
                  This browser cannot read QR codes. Type or paste the ticket code below, or
                  scan in Chrome or Edge on Android, or Chrome on ChromeOS or macOS.
                </p>
              )}

              {camera === 'refused' && (
                <>
                  <p className="text-sm leading-relaxed text-muted">
                    We could not open the camera. Check that this site is allowed to use it in
                    your browser settings, or type the ticket code below instead.
                  </p>
                  <Button className="mt-4" onClick={() => void startCamera()}>
                    Try the camera again
                  </Button>
                </>
              )}
            </div>
          )}
        </Panel>

        {/* Always present, not a fallback tucked away: a phone that will not
            focus, a cracked screen, a printed ticket. */}
        <Panel className="px-5 py-5">
          <form onSubmit={onTypedSubmit}>
            <Field
              label="Ticket code"
              hint="Type or paste the code printed under the QR."
            >
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                placeholder="e.g. 4f1c9a2b…"
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              className="mt-4 w-full"
              loading={busy}
              disabled={!typed.trim()}
            >
              Check this ticket
            </Button>
          </form>
        </Panel>

        <section>
          <h2 className="eyebrow mb-3">Arrivals</h2>
          {arrived === 0 ? (
            <p className="text-sm text-dim">Nobody has arrived yet.</p>
          ) : (
            <ul className="divide-y divide-line rounded-[6px] border border-line bg-white">
              {[...attendance]
                .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
                .slice(0, 20)
                .map((row) => (
                  <li
                    key={row.id}
                    className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm"
                  >
                    <span className="truncate text-fg">
                      {/*
                        Two different silences, two different sentences.

                        A null profile_id is somebody who closed their account:
                        the arrival is deliberately kept and the person
                        deliberately erased, so the line says that plainly. Not
                        "Unknown", which reads as a fault in our records rather
                        than a fact about theirs, and not blank, which reads as
                        a bug. The row stays because the count it belongs to is
                        the thing this rule exists to protect.

                        A profile_id we simply have no name for is the older
                        case — a roster that has not caught up — and keeps its
                        older, vaguer wording.
                      */}
                      {row.profile_id === null
                        ? 'A guest who has since closed their account'
                        : (names[row.profile_id] ?? 'Someone on the list')}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-dim">
                      {new Date(row.recorded_at).toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                      {row.corrected && ' · added by hand'}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}
