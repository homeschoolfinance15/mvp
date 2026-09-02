import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { AuthLayout } from '../components/AuthLayout'
import { Button, CopyCode, Field, Input, Notice, Textarea } from '../components/ui'
import { errorMessage, supabase } from '../lib/supabase'
import { homePathFor, needsOnboarding, useAuth } from '../context/AuthProvider'

/**
 * Collects the two fields that make someone findable: what they do now, and how
 * they'd describe themselves. `semantic_summary` is the text that will later be
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
      })
      .eq('id', profile.id)

    if (updateError) {
      setError(errorMessage(updateError))
      setBusy(false)
      return
    }

    await refreshProfile()
    navigate(isConnector ? '/connector' : '/home', { replace: true })
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
