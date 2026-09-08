import { useEffect, useRef, useState } from 'react'
import { MIN_QUERY, searchCities, type CityHit } from '../lib/cities'
import { Field, Input } from './ui'

/**
 * "City search + fallback."
 *
 * The input is always the answer. Suggestions fill it in faster, and
 * everything works with them switched off, unreachable, or simply wrong
 * about where somebody lives.
 *
 * Keyboard: up and down move through suggestions, Enter takes the
 * highlighted one, Escape dismisses without changing what was typed.
 */
export function CitySearch({
  value,
  onChange,
  label = 'Where are you based?',
  hint = 'City, region and country. No street address.',
}: {
  value: string
  onChange: (next: string) => void
  label?: string
  hint?: string
}) {
  const [hits, setHits] = useState<CityHit[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [searching, setSearching] = useState(false)

  const boxRef = useRef<HTMLDivElement>(null)
  // What was last chosen or typed deliberately, so re-rendering does not
  // reopen the list on top of a settled answer.
  const settled = useRef(value)

  useEffect(() => {
    const query = value.trim()
    if (query === settled.current || query.length < MIN_QUERY) {
      setHits([])
      return
    }

    const controller = new AbortController()
    setSearching(true)
    // Debounced, because this is somebody else's service and one request per
    // keystroke is rude as well as slow.
    const timer = setTimeout(async () => {
      const found = await searchCities(query, controller.signal)
      setHits(found)
      setActive(-1)
      setOpen(found.length > 0)
      setSearching(false)
    }, 300)

    return () => {
      clearTimeout(timer)
      controller.abort()
      setSearching(false)
    }
  }, [value])

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function choose(hit: CityHit) {
    settled.current = hit.label
    onChange(hit.label)
    setOpen(false)
    setHits([])
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || hits.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % hits.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i <= 0 ? hits.length - 1 : i - 1))
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault()
      choose(hits[active])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <Field label={label} hint={hint}>
        <Input
          value={value}
          onChange={(e) => {
            settled.current = ''
            onChange(e.target.value)
          }}
          onKeyDown={onKeyDown}
          onFocus={() => hits.length > 0 && setOpen(true)}
          placeholder="Manchester, England"
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="city-suggestions"
        />
      </Field>

      {searching && (
        <p aria-live="polite" className="mt-1.5 text-xs text-dim">
          Searching...
        </p>
      )}

      {open && hits.length > 0 && (
        <ul
          id="city-suggestions"
          role="listbox"
          className="absolute z-30 mt-1 w-full overflow-hidden rounded-sm border border-line bg-ink shadow-xl"
        >
          {hits.map((hit, i) => (
            <li key={hit.label} role="option" aria-selected={i === active}>
              <button
                type="button"
                // onMouseDown, because onClick lands after the input has lost
                // focus and closed the list.
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(hit)
                }}
                onMouseEnter={() => setActive(i)}
                className={`block w-full px-3 py-2.5 text-left text-sm transition-colors ${
                  i === active ? 'bg-gold-wash text-fg' : 'text-muted hover:text-fg'
                }`}
              >
                <span className="text-fg">{hit.name}</span>
                {(hit.region || hit.country) && (
                  <span className="text-dim">
                    {' '}
                    {[hit.region, hit.country].filter(Boolean).join(', ')}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The fallback the handoff asks for, stated rather than implied. */}
      {value.trim().length >= MIN_QUERY && !searching && hits.length === 0 && (
        <p className="mt-1.5 text-xs text-dim">
          No match. What you have typed is fine as it is.
        </p>
      )}
    </div>
  )
}
