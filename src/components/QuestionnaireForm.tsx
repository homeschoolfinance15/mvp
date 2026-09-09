import { useCallback, useEffect, useState } from 'react'
import {
  AGE_RANGES,
  DISCLOSURE,
  EMPTY_TAG_ANSWER,
  GATHERING_OPTIONS,
  INITIAL_ORDER,
  LATER_ORDER,
  PREFERENCE_CAVEAT,
  TAG_QUESTIONS,
  TEXT_QUESTIONS,
  tagCount,
} from '../lib/questionnaire'
import { errorMessage, supabase } from '../lib/supabase'
import type {
  GatheringKind,
  ProfileAnswers,
  ProfileTag,
  TagAnswer,
  TagField,
} from '../lib/types'
import { CitySearch } from './CitySearch'
import { TagPicker } from './TagPicker'
import { TravelSlider } from './TravelSlider'
import { Button, Field, Input, Notice, Panel, Spinner, Textarea } from './ui'

/**
 * The signup questionnaire.
 *
 * Two stages, per the handoff: five questions during signup, the rest offered
 * afterwards as "Tell us more". Every answer stays editable, which is why the
 * profile page renders the same component with both stages shown.
 *
 * Saving is per step: "Save a step before advancing, preserve answers when
 * navigating back, and restore the latest saved step after refresh." The row
 * is upserted, so a refresh mid-signup resumes from what is already stored.
 */

type Draft = Partial<ProfileAnswers>

const TAG_FIELDS: TagField[] = [
  'current_focus',
  'desired_outcomes',
  'conversation_topics',
  'outside_work_interests',
  'strongest_skills',
]

function answerOf(draft: Draft, field: TagField): TagAnswer {
  return (draft[field] as TagAnswer | undefined) ?? EMPTY_TAG_ANSWER
}

/** Count what a person perceives, so an emoji is one character. */
const perceived = (value: string) => [...value].length

/**
 * Trim to a character count rather than a UTF-16 length.
 *
 * maxLength on a textarea counts code units, so an emoji costs two and
 * somebody using them hits the ceiling early. The handoff asks for
 * user-perceived characters, counted the same way in the UI and the API.
 */
function clampPerceived(value: string, max: number): string {
  const chars = [...value]
  return chars.length <= max ? value : chars.slice(0, max).join('')
}

export function QuestionnaireForm({
  profileId,
  mode,
  onComplete,
}: {
  profileId: string
  /** 'signup' walks the two stages; 'edit' shows everything at once. */
  mode: 'signup' | 'edit'
  onComplete?: () => void | Promise<void>
}) {
  const [tags, setTags] = useState<ProfileTag[]>([])
  const [draft, setDraft] = useState<Draft>({})
  const [stage, setStage] = useState<'initial' | 'more'>('initial')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)

  const load = useCallback(async () => {
    const [tagsRes, answersRes] = await Promise.all([
      supabase.from('profile_tags').select('*').order('field').order('position'),
      supabase.from('profile_answers').select('*').eq('profile_id', profileId).maybeSingle(),
    ])

    setTags((tagsRes.data as ProfileTag[]) ?? [])
    const existing = answersRes.data as ProfileAnswers | null
    if (existing) {
      setDraft(existing)
      // Restore the latest saved step: if the initial stage is already
      // answered, there is no reason to walk it again.
      if (mode === 'signup' && existing.completed_at) setStage('more')
    }
    setLoading(false)
  }, [profileId, mode])

  useEffect(() => {
    void load()
  }, [load])

  function set<K extends keyof ProfileAnswers>(field: K, value: ProfileAnswers[K]) {
    setDraft((d) => ({ ...d, [field]: value }))
    setSaved(false)
  }

  /** Blank optional answers save as null for text and [] for selections. */
  function payload(): Record<string, unknown> {
    const body: Record<string, unknown> = { profile_id: profileId }

    for (const field of TAG_FIELDS) body[field] = answerOf(draft, field)

    for (const key of [
      'current_focus_details',
      'desired_outcomes_details',
      'current_project',
      'background',
      'room_contribution',
      'current_conversation_need',
      'curation_notes',
      'home_city',
      'travel_preference',
      'phone',
      'age_range',
      'travel_destinations',
    ] as const) {
      const raw = draft[key]
      body[key] = typeof raw === 'string' && raw.trim() ? raw.trim() : null
    }

    body.gathering_preference = draft.gathering_preference ?? []
    body.travels_often = draft.travels_often ?? null
    return body
  }

  /** The handoff's rules, applied identically here and in the database. */
  function problem(): string | null {
    if (stage === 'initial' || mode === 'edit') {
      for (const q of TAG_QUESTIONS.filter((x) => x.stage === 'initial')) {
        const answer = answerOf(draft, q.field)
        if (tagCount(answer) < q.min) {
          return `${q.prompt} Choose at least ${q.min}.`
        }
        // "Show 'Please tell us a little more' when selected without nonblank
        // details."
        if (q.detailsField) {
          const somethingElse = answer.selected_tag_ids.some((id) =>
            id.endsWith('.something_else'),
          )
          const details = (draft[q.detailsField] ?? '').toString().trim()
          if (somethingElse && !details) return 'Please tell us a little more.'
        }
      }

      const project = (draft.current_project ?? '').trim()
      if (!project) return "Tell us what you're working on."
      if (!draft.phone?.trim()) return 'What is your phone number?'
      if (!draft.home_city?.trim()) return 'Where are you based?'
      if (!draft.travel_preference) return 'How far are you willing to travel?'
    }
    return null
  }

  async function save(advance: boolean) {
    setError('')
    const found = problem()
    if (found) {
      setError(found)
      return
    }

    setBusy(true)
    const body = payload()
    if (advance || mode === 'edit') body.completed_at = new Date().toISOString()

    const { error: saveError } = await supabase
      .from('profile_answers')
      .upsert(body, { onConflict: 'profile_id' })

    setBusy(false)
    if (saveError) {
      setError(`We could not save that. ${errorMessage(saveError)}`)
      setSaveFailed(true)
      return
    }

    setSaveFailed(false)
    setSaved(true)
    if (advance) {
      setStage('more')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
    if (mode === 'edit') await onComplete?.()
  }

  async function finish() {
    await save(false)
    if (!problem()) await onComplete?.()
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-dim">
        <Spinner />
      </div>
    )
  }

  const showInitial = mode === 'edit' || stage === 'initial'
  const showMore = mode === 'edit' || stage === 'more'

  const tagsFor = (field: TagField) => tags.filter((t) => t.field === field)

  /** One question, tag or text, chosen by field key so order is data. */
  function renderQuestion(field: string) {
    const tagQuestion = TAG_QUESTIONS.find((q) => q.field === field)
    if (tagQuestion) {
      const answer = answerOf(draft, tagQuestion.field)
      const somethingElse = answer.selected_tag_ids.some((id) =>
        id.endsWith('.something_else'),
      )
      return (
        <Panel key={field} className="px-5 py-5 sm:px-6">
          <TagPicker
            label={tagQuestion.prompt}
            helper={tagQuestion.helper}
            tags={tagsFor(tagQuestion.field)}
            value={answer}
            max={tagQuestion.max}
            allowCustom={tagQuestion.allowCustom}
            onChange={(next) => set(tagQuestion.field, next)}
          />

          {tagQuestion.detailsField && (
            <>
              <div className="mt-5">
                <Field
                  label={tagQuestion.detailsPrompt ?? 'Tell us a little more.'}
                  hint={somethingElse ? 'Required, since you chose Something else.' : 'Optional.'}
                >
                  <Textarea
                    rows={2}
                    value={(draft[tagQuestion.detailsField] ?? '') as string}
                    placeholder={tagQuestion.detailsPlaceholder}
                    onChange={(e) =>
                      set(tagQuestion.detailsField!, clampPerceived(e.target.value, 300))
                    }
                  />
                </Field>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-dim">{PREFERENCE_CAVEAT}</p>
            </>
          )}
        </Panel>
      )
    }

    const textQuestion = TEXT_QUESTIONS.find((q) => q.field === field)
    if (!textQuestion) return null
    const value = (draft[textQuestion.field] ?? '') as string
    return (
      <Panel key={field} className="px-5 py-5 sm:px-6">
        <Field label={textQuestion.prompt} hint={textQuestion.helper}>
          <Textarea
            rows={3}
            value={value}
            placeholder={textQuestion.placeholder}
            onChange={(e) =>
              set(textQuestion.field, clampPerceived(e.target.value, textQuestion.maxLength))
            }
          />
        </Field>
        <p className="mt-2 text-right text-xs text-dim tabular-nums">
          {textQuestion.maxLength - perceived(value)} left
        </p>
      </Panel>
    )
  }

  return (
    <div className="space-y-8">
      {mode === 'signup' && stage === 'initial' && (
        <p className="text-xs leading-relaxed text-dim">{DISCLOSURE}</p>
      )}

      {showInitial && (
        <>
          {/* "After the existing account and location fields, show the five
              initial questions below in order." So the practical fields come
              first, then Q0, Q1, Q3, Q5, Q7. */}
          <Panel className="space-y-5 px-5 py-5 sm:px-6">
            <CitySearch
              value={draft.home_city ?? ''}
              onChange={(next) => set('home_city', next)}
            />

            {/* Required, unlike LinkedIn: a gathering is arranged in person and
                at short notice, and an email nobody reads is no way to tell
                somebody the room moved. */}
            <Field
              label="Phone number"
              hint="Only ever used to reach you about a gathering."
            >
              <Input
                required
                type="tel"
                autoComplete="tel"
                value={draft.phone ?? ''}
                onChange={(e) => set('phone', e.target.value)}
              />
            </Field>

            <TravelSlider
              value={draft.travel_preference ?? null}
              onChange={(id) => set('travel_preference', id)}
            />
          </Panel>

          {INITIAL_ORDER.map((field) => renderQuestion(field))}
        </>
      )}

      {showMore && (
        <>
          {mode === 'signup' && (
            <div>
              <h2 className="display text-2xl">Tell us more</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                All optional, and you can come back to it whenever you like.
              </p>
            </div>
          )}

          {/* Q2, Q4, Q6, Q9, then Q10 last, as listed. */}
          {LATER_ORDER.map((field) => renderQuestion(field))}

          <Panel className="space-y-6 px-5 py-5 sm:px-6">
            <fieldset className="border-0 p-0">
              <legend className="eyebrow mb-1.5">
                Which gatherings do you enjoy most?
              </legend>
              <p className="mb-3 text-xs text-dim">
                Press them in order, favourite first.
              </p>
              <ul className="flex flex-wrap gap-2">
                {GATHERING_OPTIONS.map((option) => {
                  const ranked = draft.gathering_preference ?? []
                  const rank = ranked.indexOf(option.id as GatheringKind)
                  return (
                    <li key={option.id}>
                      <button
                        type="button"
                        onClick={() =>
                          set(
                            'gathering_preference',
                            rank === -1
                              ? [...ranked, option.id as GatheringKind]
                              : ranked.filter((g) => g !== option.id),
                          )
                        }
                        className={`rounded-sm border px-3 py-1.5 text-xs transition-colors ${
                          rank === -1
                            ? 'border-line text-muted hover:text-fg'
                            : 'border-gold bg-gold-wash text-fg'
                        }`}
                      >
                        {rank !== -1 && (
                          <span className="mr-1.5 text-gold tabular-nums">{rank + 1}</span>
                        )}
                        {option.label}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </fieldset>

            <Field label="Age range" hint="Optional.">
              <select
                value={draft.age_range ?? ''}
                onChange={(e) => set('age_range', e.target.value)}
                className="h-10 w-full cursor-pointer rounded-sm border border-line bg-transparent px-3 pr-8 text-sm text-fg focus:border-gold focus:outline-none"
              >
                <option value="">Prefer not to say</option>
                {AGE_RANGES.map((range) => (
                  <option key={range} value={range}>
                    {range}
                  </option>
                ))}
              </select>
            </Field>

            <fieldset className="border-0 p-0">
              <legend className="eyebrow mb-3">Do you travel somewhere often?</legend>
              <ul className="flex gap-2">
                {[
                  { v: true, label: 'Yes' },
                  { v: false, label: 'No' },
                ].map((option) => (
                  <li key={String(option.v)}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={draft.travels_often === option.v}
                      onClick={() => set('travels_often', option.v)}
                      className={`rounded-sm border px-4 py-1.5 text-xs transition-colors ${
                        draft.travels_often === option.v
                          ? 'border-gold bg-gold-wash text-fg'
                          : 'border-line text-muted hover:text-fg'
                      }`}
                    >
                      {option.label}
                    </button>
                  </li>
                ))}
              </ul>

              {draft.travels_often === true && (
                <div className="mt-4">
                  <Field label="Where?">
                    <Input
                      value={draft.travel_destinations ?? ''}
                      placeholder="London most months, New York twice a year"
                      onChange={(e) => set('travel_destinations', e.target.value)}
                    />
                  </Field>
                </div>
              )}
            </fieldset>
          </Panel>
        </>
      )}

      <div aria-live="polite">
        {error && <Notice tone="error">{error}</Notice>}
        {saved && !error && <Notice tone="success">Saved.</Notice>}
      </div>

      {saveFailed && (
        <Button type="button" onClick={() => save(stage === 'initial' && mode === 'signup')}>
          Try saving again
        </Button>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {mode === 'signup' && stage === 'more' ? (
          <Button type="button" onClick={() => setStage('initial')}>
            Back
          </Button>
        ) : (
          <span />
        )}

        <div className="flex flex-wrap gap-3">
          {mode === 'signup' && stage === 'more' && (
            <Button type="button" onClick={() => void onComplete?.()}>
              Skip for now
            </Button>
          )}
          <Button
            variant="primary"
            loading={busy}
            onClick={() => (mode === 'signup' && stage === 'initial' ? save(true) : finish())}
          >
            {mode === 'edit' ? 'Save answers' : stage === 'initial' ? 'Next' : 'Finish'}
          </Button>
        </div>
      </div>
    </div>
  )
}
