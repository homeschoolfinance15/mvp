import { useMemo, useState } from 'react'
import {
  customTagProblem,
  normaliseCustomTag,
  tagCount,
  VISIBLE_BEFORE_SHOW_ALL,
} from '../lib/questionnaire'
import type { ProfileTag, TagAnswer } from '../lib/types'
import { Notice } from './ui'

/**
 * Multi-select chips, to the handoff's picker rules.
 *
 *   Start empty. Never preselect answers.
 *   Show a selection count such as "2 of 5 selected".
 *   At the limit, disable unselected options while keeping selected ones
 *     removable.
 *   Show the first 12, with "Show all". Search always includes hidden options.
 *   Custom entries count toward the same limit.
 *
 * Accessibility, also from the handoff: checkbox semantics, keyboard
 * navigation, visible focus, screen-reader announcements for counts and
 * errors, and "Selected states need a checkmark as well as a color change."
 */
export function TagPicker({
  tags,
  value,
  onChange,
  max,
  allowCustom,
  helper,
  label,
}: {
  tags: ProfileTag[]
  value: TagAnswer
  onChange: (next: TagAnswer) => void
  max: number
  allowCustom: boolean
  helper: string
  label: string
}) {
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [customDraft, setCustomDraft] = useState('')
  const [customError, setCustomError] = useState('')

  const selected = tagCount(value)
  const atLimit = selected >= max

  const labels = useMemo(() => tags.map((t) => t.label), [tags])

  // Search always covers the whole catalog, not just what is on screen.
  const matching = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return showAll ? tags : tags.slice(0, VISIBLE_BEFORE_SHOW_ALL)
    return tags.filter((t) => t.label.toLowerCase().includes(q))
  }, [tags, search, showAll])

  const hiddenCount = tags.length - VISIBLE_BEFORE_SHOW_ALL

  function toggle(id: string) {
    const has = value.selected_tag_ids.includes(id)
    if (!has && atLimit) return
    onChange({
      ...value,
      selected_tag_ids: has
        ? value.selected_tag_ids.filter((x) => x !== id)
        : [...value.selected_tag_ids, id],
    })
  }

  function addCustom() {
    const problem = customTagProblem(customDraft, value, labels)
    if (problem) {
      setCustomError(problem)
      return
    }
    if (atLimit) {
      setCustomError(`You can choose ${max} in total.`)
      return
    }
    onChange({ ...value, custom_tags: [...value.custom_tags, normaliseCustomTag(customDraft)] })
    setCustomDraft('')
    setCustomError('')
  }

  return (
    <fieldset className="border-0 p-0">
      <legend className="eyebrow mb-1.5">{label}</legend>
      <p className="mb-3 text-xs leading-relaxed text-dim">{helper}</p>

      <p aria-live="polite" className="mb-3 text-xs text-muted tabular-nums">
        {selected} of {max} selected
      </p>

      {tags.length > VISIBLE_BEFORE_SHOW_ALL && (
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search"
          aria-label={`Search ${label.toLowerCase()}`}
          className="mb-3 h-10 w-full rounded-sm border border-line bg-transparent px-3 text-sm text-fg placeholder:text-dim focus:border-gold focus:outline-none"
        />
      )}

      <ul className="flex flex-wrap gap-2">
        {matching.map((tag) => {
          const isSelected = value.selected_tag_ids.includes(tag.id)
          const disabled = !isSelected && atLimit
          return (
            <li key={tag.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={isSelected}
                disabled={disabled}
                onClick={() => toggle(tag.id)}
                className={`rounded-sm border px-3 py-1.5 text-xs transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-gold ${
                  isSelected
                    ? 'border-gold bg-gold-wash text-fg'
                    : disabled
                      ? 'cursor-not-allowed border-line text-dim opacity-45'
                      : 'border-line text-muted hover:border-line-strong hover:text-fg'
                }`}
              >
                {/* A checkmark as well as a colour change. */}
                {isSelected && <span aria-hidden>&#10003; </span>}
                {tag.label}
              </button>
            </li>
          )
        })}

        {value.custom_tags.map((tag) => (
          <li key={`custom-${tag}`}>
            <button
              type="button"
              role="checkbox"
              aria-checked
              onClick={() =>
                onChange({
                  ...value,
                  custom_tags: value.custom_tags.filter((t) => t !== tag),
                })
              }
              className="rounded-sm border border-gold bg-gold-wash px-3 py-1.5 text-xs text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-gold"
            >
              <span aria-hidden>&#10003; </span>
              {tag}
              <span aria-hidden className="ml-1.5 text-dim">
                &#10005;
              </span>
            </button>
          </li>
        ))}
      </ul>

      {!search && !showAll && hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-3 text-xs text-gold underline-offset-4 hover:underline"
        >
          Show all {tags.length}
        </button>
      )}

      {search && matching.length === 0 && (
        <p className="mt-3 text-xs text-dim">Nothing matches that.</p>
      )}

      {allowCustom && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={customDraft}
              onChange={(e) => {
                setCustomDraft(e.target.value)
                setCustomError('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addCustom()
                }
              }}
              maxLength={50}
              placeholder="Add your own"
              aria-label={`Add your own ${label.toLowerCase()}`}
              className="h-9 min-w-0 flex-1 rounded-sm border border-line bg-transparent px-3 text-sm text-fg placeholder:text-dim focus:border-gold focus:outline-none"
            />
            <button
              type="button"
              onClick={addCustom}
              disabled={!customDraft.trim()}
              className="rounded-sm border border-line px-3 py-1.5 text-xs text-muted transition-colors hover:text-fg disabled:opacity-45"
            >
              Add
            </button>
          </div>
          {customError && (
            <p aria-live="polite" className="mt-2 text-xs text-red-400">
              {customError}
            </p>
          )}
        </div>
      )}

      {atLimit && (
        <div className="mt-3">
          <Notice tone="success">
            That is {max}. Remove one to choose something else.
          </Notice>
        </div>
      )}
    </fieldset>
  )
}
