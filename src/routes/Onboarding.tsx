import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { AuthLayout } from '../components/AuthLayout'
import { Button, CopyCode, Field, Input, Notice, Textarea } from '../components/ui'
import { INTERESTS_PLACEHOLDER, parseInterests } from '../lib/interests'
import { errorMessage, supabase } from '../lib/supabase'
import {
  homePathFor,
  needsOnboarding,
  needsQuestionnaire,
  useAuth,
} from '../context/AuthProvider'
import { takeSignupResume } from '../lib/signupResume'

/**
 * Collects what makes someone findable: what they do now, what they care
 * about, and how they'd describe themselves. `semantic_summary` and
 * `interests` are the cold-start signal for matching — the text that will be
 * embedded into `search_documents`.
 */
export default function Onboarding() {
  const { profile, refreshProfile } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  // Connectors arrive from /join carrying the code that was minted for them.
  const firstCode = (location.state as { firstCode?: string } | null)?.firstCode

  const [profession, setProfession] = useState(profile?.current_profession ?? '')
  const [summary, setSummary] = useState(profile?.semantic_summary ?? '')
  const [interests, setInterests] = useState('')
  // Asked at the waitlist door, so ask it here too: an invited member should
  // not be the only one the network holds less on.
  const [linkedin, setLinkedin] = useState(profile?.linkedin_url ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (profile && !needsOnboarding(profile)) {
    return <Navigate to={homePathFor(profile)} replace />
  }

  const isConnector = profile?.role === 'connector'

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    setError('')
    setBusy(true)

    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        current_profession: profession.trim(),
        semantic_summary: summary.trim() || null,
        interests: parseInterests(interests),
        linkedin_url: linkedin.trim() || null,
      })
      .eq('id', profile.id)

    if (updateError) {
      setError(errorMessage(updateError))
      setBusy(false)
      return
    }

    await refreshProfile()

    /*
     * Where onboarding ends depends on who finished it, and the answer has to
     * be worked out from the row we just wrote rather than from `profile`.
     * `refreshProfile` has updated the context, but this closure still holds
     * the profile as it was a moment ago — one with no profession — and
     * `needsQuestionnaire` short-circuits to false while onboarding is
     * outstanding. Asking it about the stale row would send every network
     * member past the questionnaire, which is the opposite of the bug below.
     * So we ask it about what we know is now stored.
     */
    const settled = { ...profile, current_profession: profession.trim() }

    if (needsQuestionnaire(settled)) {
      // A member being curated into the network. Straight into the curation
      // questionnaire; the handoff puts it right after the account fields.
      //
      // The signup resume is deliberately left where it is. /questions is the
      // last required step for this person and reads it there — taking it here
      // would consume it one screen early and strand them (ACC-07).
      navigate('/questions', { replace: true })
      return
    }

    /*
     * Everybody else is finished: an admin, a connector, or — the case this
     * branch exists for — somebody who holds an account only so they can
     * attend an event. ACC-02's principle is that buying a ticket must not
     * draw you into a network, and the two-stage curation questionnaire is
     * precisely the network drawing somebody in. `needsQuestionnaire` already
     * says they are not owed it; until now nothing asked.
     *
     * Which makes this also the end of the ACC-07 journey for an event-only
     * account, so the resume is read here. It is only taken on the path that
     * uses it, so a member's resume survives to /questions untouched.
     */
    const resume = takeSignupResume()
    navigate(resume?.path ?? homePathFor(settled), { replace: true })
  }

  return (
    <AuthLayout
      eyebrow={isConnector ? 'Connector setup' : 'Welcome to AMAZING'}
      title={`Tell us about you, ${profile?.full_name.split(' ')[0] ?? 'friend'}`}
      caption={
        isConnector
          ? 'This is what the people you invite will see when they land on their dashboard.'
          : 'More than a title. This is how the network comes to understand what you bring.'
      }
    >
      {firstCode && (
        <div className="mb-7 rounded-sm border border-gold/25 bg-gold-wash px-4 py-4">
          <p className="eyebrow text-gold-dim">Your first invitation code</p>
          <div className="mt-3">
            <CopyCode code={firstCode} />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Share this with the people you'd like to bring in. You can always find it on your
            dashboard.
          </p>
        </div>
      )}

      <form onSubmit={submit} className="space-y-5">
        <Field label="Current profession">
          <Input
            required
            value={profession}
            onChange={(e) => setProfession(e.target.value)}
            placeholder="Founder & CEO, Northwind Labs"
          />
        </Field>

        <Field
          label="Interests"
          hint="A few words each. These are what the network matches you on."
        >
          <Input
            value={interests}
            onChange={(e) => setInterests(e.target.value)}
            placeholder={INTERESTS_PLACEHOLDER}
          />
        </Field>

        <Field label="LinkedIn" hint="Optional.">
          <Input
            type="url"
            value={linkedin}
            onChange={(e) => setLinkedin(e.target.value)}
            placeholder="linkedin.com/in/..."
            autoComplete="url"
          />
        </Field>

        <Field
          label="A little more"
          hint="What you're building, what you're curious about, what you're looking for."
        >
          <Textarea
            rows={5}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="I'm building infrastructure for climate finance, and I spend most of my curiosity on how capital actually reaches the ground..."
          />
        </Field>

        {error && <Notice tone="error">{error}</Notice>}

        <Button type="submit" variant="primary" loading={busy} className="w-full">
          Enter the network
        </Button>
      </form>
    </AuthLayout>
  )
}
