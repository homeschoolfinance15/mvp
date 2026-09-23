import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { homePathFor, useAuth } from '../context/AuthProvider'
import { supabase, errorMessage } from '../lib/supabase'
import { toLink } from '../lib/url'
import { Button, Field, Input, Modal, Notice, Textarea, Wordmark } from '../components/ui'
import { CitySearch } from '../components/CitySearch'
import { TagPicker } from '../components/TagPicker'
import { TravelSlider } from '../components/TravelSlider'
import { LandingPreview } from '../components/LandingPreview'
import {
  DISCLOSURE,
  EMPTY_TAG_ANSWER,
  INITIAL_ORDER,
  TAG_QUESTIONS,
  TEXT_QUESTIONS,
} from '../lib/questionnaire'
import type { CodeLookup, ProfileTag, TagAnswer, TagField } from '../lib/types'

/**
 * One question to a page, in the handoff's initial order, then location.
 *
 * A single page holding all of it reads as a wall and gets abandoned; the same
 * questions arriving one at a time read as a short conversation. Nothing here
 * is required past name and email, so Next doubles as Skip.
 */
const STEPS = ['who', ...INITIAL_ORDER, 'where'] as const

/**
 * The public waitlist form.
 *
 * The handoff says waitlist applicants answer the same questionnaire. Everything
 * past name and email is optional: a stranger asked thirty questions at the door
 * leaves. Whatever they do answer is carried onto their profile when an admin
 * lets them in, so nobody answers twice.
 */
function WaitlistForm({ onClose }: { onClose: () => void }) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [linkedin, setLinkedin] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const [page, setPage] = useState(0)
  const [tags, setTags] = useState<ProfileTag[]>([])
  const [answers, setAnswers] = useState<Record<string, TagAnswer>>({})
  const [text, setText] = useState<Record<string, string>>({})
  const [homeCity, setHomeCity] = useState('')
  const [travel, setTravel] = useState('')

  const last = STEPS.length - 1
  const stepKey = STEPS[page]

  useEffect(() => {
    if (page === 0 || tags.length > 0) return
    void supabase
      .from('profile_tags')
      .select('*')
      .order('field')
      .order('position')
      .then(({ data }) => setTags((data as ProfileTag[]) ?? []))
  }, [page, tags.length])

  const answerOf = (field: TagField) => answers[field] ?? EMPTY_TAG_ANSWER

  async function submit() {
    setError('')
    setBusy(true)

    const body: Record<string, unknown> = {
      full_name: fullName.trim(),
      email: email.trim().toLowerCase(),
      linkedin_url: toLink(linkedin),
      phone: phone.trim(),
      home_city: homeCity.trim() || null,
      travel_preference: travel || null,
    }
    for (const q of TAG_QUESTIONS) body[q.field] = answerOf(q.field)
    for (const q of TEXT_QUESTIONS) body[q.field] = text[q.field]?.trim() || null

    const { error: insertError } = await supabase.from('waitlist_entries').insert(body)

    setBusy(false)

    if (insertError) {
      setError(
        insertError.code === '23505'
          ? "You're already on the list. We'll be in touch."
          : insertError.code === '23514'
            ? insertError.message.includes('waitlist_phone_present')
              ? 'Please enter a phone number.'
              : 'Some of your answers could not be saved. Please check them and try again.'
            : insertError.message,
      )
      return
    }

    // The acknowledgement email. Deliberately not awaited into the outcome:
    // they are on the list either way, and a mail provider having a bad
    // minute is not a reason to show somebody an error about an application
    // that succeeded. The function refuses to send twice.
    void supabase.functions
      .invoke('waitlist-email', { body: { email: body.email } })
      .then(({ error: mailError }) => {
        // Never shown to the applicant, who is on the list either way. It is
        // here because the first version of this failed silently on a CORS
        // preflight for a day: a swallowed error is a feature that looks like
        // it works.
        if (mailError) console.error('[amazing] waitlist acknowledgement:', mailError)
      })

    setDone(true)
  }

  if (done) {
    return (
      <div className="py-10 text-center">
        <p className="eyebrow">Request received</p>
        <h2 className="display mt-4 text-4xl">You’re on the list.</h2>
        <p className="mx-auto mt-5 max-w-sm text-sm leading-6 text-muted">
          Thanks, {fullName.split(' ')[0] || 'friend'}. We’ll contact you when a place opens.
        </p>
        <Button type="button" variant="secondary" onClick={onClose} className="mt-8">
          Close
        </Button>
      </div>
    )
  }

  function renderStep() {
    if (stepKey === 'who') {
      return (
        <div className="space-y-5">
          <Field label="Full name">
            <Input
              required
              autoFocus
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Jane Okonkwo"
              autoComplete="name"
            />
          </Field>

          <Field label="Email address">
            <Input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@company.com"
              autoComplete="email"
            />
          </Field>

          {/* Required, unlike LinkedIn. A place opens at short notice and a
              connector needs a way to reach somebody that is not an inbox. */}
          <Field label="Phone number">
            <Input
              required
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+44 7700 900000"
              autoComplete="tel"
            />
          </Field>

          <Field label="LinkedIn" hint="Optional">
            <Input
              inputMode="url"
              value={linkedin}
              onChange={(e) => setLinkedin(e.target.value)}
              placeholder="linkedin.com/in/..."
              autoComplete="url"
            />
          </Field>
        </div>
      )
    }

    if (stepKey === 'where') {
      return (
        <div className="space-y-7">
          <CitySearch value={homeCity} onChange={setHomeCity} />

          <TravelSlider value={travel} onChange={setTravel} />
        </div>
      )
    }

    const tagQuestion = TAG_QUESTIONS.find((q) => q.field === stepKey)
    if (tagQuestion) {
      return (
        <TagPicker
          label={tagQuestion.prompt}
          helper={tagQuestion.helper}
          tags={tags.filter((t) => t.field === tagQuestion.field)}
          value={answerOf(tagQuestion.field)}
          max={tagQuestion.max}
          allowCustom={tagQuestion.allowCustom}
          onChange={(next) => setAnswers((a) => ({ ...a, [tagQuestion.field]: next }))}
        />
      )
    }

    const textQuestion = TEXT_QUESTIONS.find((q) => q.field === stepKey)
    if (!textQuestion) return null

    return (
      <Field label={textQuestion.prompt} hint={textQuestion.helper}>
        <Textarea
          rows={4}
          maxLength={textQuestion.maxLength}
          placeholder={textQuestion.placeholder}
          value={text[textQuestion.field] ?? ''}
          onChange={(e) => setText((t) => ({ ...t, [textQuestion.field]: e.target.value }))}
        />
      </Field>
    )
  }

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        // Native validation has already passed for whatever this page holds,
        // but `required` accepts a phone number of only spaces, which the
        // database then refuses in its own words.
        if (stepKey === 'who' && !phone.trim()) {
          setError('Please enter a phone number.')
          return
        }
        setError('')
        if (page < last) {
          setPage(page + 1)
          return
        }
        void submit()
      }}
    >
      <div className="waitlist-progress">
        <div className="waitlist-progress-label">
          <span>{page === 0 ? 'Start with you' : stepKey === 'where' ? 'Your kind of place' : 'A little more about you'}</span>
          <span>Step {page + 1} of {STEPS.length}</span>
        </div>
        <div className="waitlist-progress-track" role="progressbar" aria-label="Application progress" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={page + 1}>
          <span style={{ width: `${((page + 1) / STEPS.length) * 100}%` }} />
        </div>
      </div>

      {page === 0 && (
        <p className="mb-8 text-sm leading-6 text-muted">
          Tell us a little about yourself. Every application is reviewed personally.
        </p>
      )}

      {page === 1 && (
        <>
          <p className="mb-2 text-sm leading-6 text-muted">
            A little more, so we can find you the right room. Everything from here is
            optional.
          </p>
          <p className="mb-8 text-xs leading-relaxed text-dim">{DISCLOSURE}</p>
        </>
      )}

      {renderStep()}

      {error && (
        <div className="mt-6">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <div className="mt-8 flex items-center justify-between gap-3">
        {page > 0 ? (
          <Button type="button" onClick={() => setPage(page - 1)}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" variant="primary" loading={busy}>
          {page === last ? 'Join the waitlist' : 'Next'}
        </Button>
      </div>

      {page === 0 && (
        <p className="mt-4 text-center text-xs text-dim">
          Your information is only used to review your application.
        </p>
      )}
    </form>
  )
}

export default function Landing() {
  const navigate = useNavigate()
  const { session, profile, loading: authLoading } = useAuth()
  const [code,setCode] = useState('')
  const [codeBusy, setCodeBusy] = useState(false)
  const [codeError, setCodeError] = useState('')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [waitlistOpen, setWaitlistOpen] = useState(false)

  async function enterNetwork(e: FormEvent) {
    e.preventDefault()
    setCodeError('')
    setCodeBusy(true)

    const normalizedCode = code.trim().toUpperCase()
    const { data, error } = await supabase.rpc('lookup_code', { p_code: normalizedCode })
    setCodeBusy(false)

    if (error) {
      setCodeError(errorMessage(error))
      return
    }

    const lookup = data as CodeLookup
    if (!lookup.valid) {
      setCodeError(lookup.reason)
      return
    }

    navigate('/join', { state: { code: normalizedCode, lookup } })
  }

  // Signed in: the marketing page is not somewhere to land. Straight to the app.
  if (!authLoading && session && profile) return <Navigate to={homePathFor(profile)} replace />

  return (
    <div className="brand-experience landing-page">
      <a className="brand-skip-link" href="#main-content">Skip to content</a>
      <header className="landing-header">
        <div className="landing-header-inner brand-container">
          <a className="landing-brand" href="/" aria-label="Amazing home">
            <Wordmark size="lg" />
            <span>One click. Meet your people.</span>
          </a>
          <nav className="landing-nav" aria-label="Primary navigation">
            <Link to="/signin">Sign in</Link>
            <button type="button" onClick={() => setWaitlistOpen(true)}>Join waitlist <span aria-hidden="true">↗</span></button>
          </nav>
        </div>
      </header>

      <main id="main-content" className="brand-container">
        <section className="landing-hero" aria-labelledby="hero-title">
          <div className="landing-hero-copy">
            <h1 id="hero-title">The right people.<br />The right place.</h1>
            <p className="landing-intro">Amazing connects you with people through small dinners and gatherings curated around your interests, who you’d like to meet, and places you’ll enjoy.</p>
            <button className="brand-cta" type="button" onClick={() => setWaitlistOpen(true)}>Join the waitlist <span aria-hidden="true">→</span></button>
            <p className="landing-invite">Already invited? <button type="button" onClick={() => setInviteOpen(true)}>Enter your code</button></p>
          </div>
          <img className="landing-hero-photo" src="/brand/gathering.jpg" alt="A small group sharing a lively conversation around a restaurant table" fetchPriority="high" width="1448" height="1086" />
        </section>

        <section className="landing-explain" aria-labelledby="explain-title">
          <div><p className="brand-kicker">The Amazing difference</p><h2 id="explain-title">Stop searching for<br />the right people.<br /><em>Start meeting them.</em></h2></div>
          <div className="landing-explain-copy">
            <p>Most platforms give you more people to browse, more events to search, and more decisions to make. <strong>Amazing does the opposite.</strong></p>
            <p>We learn who you are, what you’re building, what you care about, and who you should know. Then we bring the right people together — through gatherings, introductions, communities, and the right venues.</p>
            <p className="landing-manifesto">You don’t search. You show up.</p>
          </div>
        </section>

        <LandingPreview />

        <section className="landing-closing" aria-labelledby="closing-title">
          <img src="/brand/gathering.jpg" alt="" loading="lazy" width="1448" height="1086" />
          <div><p className="brand-kicker">There’s a place for you</p><h2 id="closing-title">One click.<br className="mobile-break" /> Meet your people.</h2><button className="brand-cta brand-cta--light" type="button" onClick={() => setWaitlistOpen(true)}>Find your people <span aria-hidden="true">→</span></button></div>
        </section>
      </main>

      <footer className="landing-footer brand-container">
        <span>People, not profiles.</span>
        <div><Link to="/signin">Sign in</Link><span>amazing © {new Date().getFullYear()}</span></div>
      </footer>

      <Modal open={waitlistOpen} title="Apply for the waitlist" onClose={() => setWaitlistOpen(false)}>
        <WaitlistForm onClose={() => setWaitlistOpen(false)} />
      </Modal>
      <Modal open={inviteOpen} title="Someone saved you a spot." onClose={() => setInviteOpen(false)}>
        <p className="mb-6 text-sm leading-6 text-muted">Your invitation is the start of something good. Enter the code you received to continue.</p>
        <form onSubmit={enterNetwork}>
          <Field label="Invitation code">
            <Input id="invitation-code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="AMZ-XXXX-XXXX" autoComplete="off" spellCheck={false} className="text-center tracking-[0.15em]" />
          </Field>
          {codeError && <p role="alert" className="mt-3 text-sm text-negative">{codeError}</p>}
          <Button type="submit" variant="primary" loading={codeBusy} className="mt-6 w-full">Continue with invitation code <span aria-hidden="true">→</span></Button>
        </form>
      </Modal>
    </div>
  )
}
