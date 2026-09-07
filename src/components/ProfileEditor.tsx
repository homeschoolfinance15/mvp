import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthProvider'
import { formatInterests, INTERESTS_PLACEHOLDER, parseInterests } from '../lib/interests'
import { errorMessage, supabase } from '../lib/supabase'
import { Button, Field, Input, Notice, Panel, SectionHeader, Textarea } from './ui'

/**
 * Everyone's own record, editable by them.
 *
 * profiles_update already permits `id = auth.uid()`, and the
 * protect_profile_fields trigger strips role, profile_status, id and
 * created_at from any update made by someone who is not an admin. So this
 * form is free to send whatever it holds: the columns that matter are pinned
 * in the database, not by keeping them out of the payload.
 *
 * That guarantee is what makes the correction flow safe — a member can be
 * asked to fix their own profession, and cannot promote themselves while
 * they're in there.
 */

export function ProfileEditor({ onSaved }: { onSaved?: () => Promise<void> }) {
  const { profile, refreshProfile } = useAuth()

  const [fullName, setFullName] = useState(profile?.full_name ?? '')
  const [profession, setProfession] = useState(profile?.current_profession ?? '')
  const [summary, setSummary] = useState(profile?.semantic_summary ?? '')
  const [interests, setInterests] = useState(formatInterests(profile?.interests))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const dirty =
    fullName !== (profile?.full_name ?? '') ||
    profession !== (profile?.current_profession ?? '') ||
    summary !== (profile?.semantic_summary ?? '') ||
    interests !== formatInterests(profile?.interests)

  function edit<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v)
      setSaved(false)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    setError('')
    setSaved(false)
    setBusy(true)

    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        full_name: fullName.trim(),
        current_profession: profession.trim(),
        semantic_summary: summary.trim() || null,
        interests: parseInterests(interests),
      })
      .eq('id', profile.id)

    setBusy(false)
    if (updateError) {
      setError(errorMessage(updateError))
      return
    }
    await refreshProfile()
    await onSaved?.()
    setSaved(true)
  }

  return (
    <section>
      <SectionHeader
        title="How you're described"
        caption="This is the context the network reads you by. Keep it current — other members can raise a correction if it drifts."
      />
      <Panel className="px-6 py-6">
        <form onSubmit={submit} className="space-y-5">
          <Field label="Full name">
            <Input
              required
              value={fullName}
              onChange={(e) => edit(setFullName)(e.target.value)}
            />
          </Field>

          <Field label="Current profession">
            <Input
              required
              value={profession}
              onChange={(e) => edit(setProfession)(e.target.value)}
            />
          </Field>

          <Field label="Interests">
            <Input
              value={interests}
              onChange={(e) => edit(setInterests)(e.target.value)}
              placeholder={INTERESTS_PLACEHOLDER}
            />
          </Field>

          <Field label="A little more">
            <Textarea
              rows={6}
              value={summary}
              onChange={(e) => edit(setSummary)(e.target.value)}
              placeholder="What you're building, what you're curious about, what you're looking for."
            />
          </Field>

          {error && <Notice tone="error">{error}</Notice>}
          {saved && !dirty && <Notice tone="success">Saved.</Notice>}

          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
              Save changes
            </Button>
          </div>
        </form>
      </Panel>
    </section>
  )
}
