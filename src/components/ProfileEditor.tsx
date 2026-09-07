import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthProvider'
import { formatInterests, INTERESTS_PLACEHOLDER, parseInterests } from '../lib/interests'
import { forgetSigned, removeMedia, signMedia, uploadMedia } from '../lib/media'
import { errorMessage, supabase } from '../lib/supabase'
import {
  Button,
  Field,
  Initials,
  Input,
  Notice,
  Panel,
  SectionHeader,
  Textarea,
} from './ui'

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

  // The picture saves on its own rather than waiting for the form: choosing a
  // file is the whole gesture, and nobody expects to press Save afterwards.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const path = profile?.avatar_path
    if (!path) {
      setAvatarUrl(null)
      return
    }
    let live = true
    void signMedia([path])
      .then((urls) => { if (live) setAvatarUrl(urls[path] ?? null) })
      .catch(() => { if (live) setAvatarUrl(null) })
    return () => { live = false }
  }, [profile?.avatar_path])

  async function chooseAvatar(file: File | undefined) {
    if (!file || !profile) return
    setError('')
    setUploading(true)
    const previous = profile.avatar_path

    try {
      const [uploaded] = await uploadMedia([file])
      if (!uploaded) throw new Error('Nothing was uploaded.')

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ avatar_path: uploaded.path })
        .eq('id', profile.id)
      if (updateError) throw updateError

      // Only once the row points at the new one — otherwise a failure here
      // would leave the profile referencing a picture that no longer exists.
      if (previous) {
        forgetSigned(previous)
        await removeMedia([previous])
      }
      await refreshProfile()
    } catch (uploadError) {
      setError(errorMessage(uploadError))
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

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
        caption="This is the context the network reads you by. Keep it current. Other members can raise a correction if it drifts."
      />
      <Panel className="px-6 py-6">
        <div className="mb-6 flex items-center gap-4 border-b border-line pb-6">
          <Initials
            name={profile?.full_name ?? '?'}
            url={avatarUrl ?? undefined}
            role={profile?.role}
            size="lg"
          />
          <div className="min-w-0">
            <label className="cursor-pointer text-xs tracking-[0.1em] text-gold uppercase transition-colors hover:text-fg">
              {uploading ? 'Uploading…' : avatarUrl ? 'Change picture' : 'Add a picture'}
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                disabled={uploading}
                onChange={(e) => chooseAvatar(e.target.files?.[0])}
              />
            </label>
            <p className="mt-1.5 text-xs text-dim">
              A photograph of you. Saves as soon as you choose it.
            </p>
          </div>
        </div>

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
