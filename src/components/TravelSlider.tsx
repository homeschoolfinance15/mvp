import { useEffect } from 'react'
import { TRAVEL_CAVEAT, TRAVEL_DEFAULT_INDEX, TRAVEL_OPTIONS } from '../lib/questionnaire'

/**
 * "How far are you willing to travel?" as a slider rather than four buttons.
 *
 * The stored value is unchanged — still one of the TRAVEL_OPTIONS ids, so the
 * database constraint and the admin screens read exactly what they read
 * before. The slider only moves between them.
 */
export function TravelSlider({
  value,
  onChange,
}: {
  value: string | null
  onChange: (id: string) => void
}) {
  const found = TRAVEL_OPTIONS.findIndex((o) => o.id === value)
  const index = found === -1 ? TRAVEL_DEFAULT_INDEX : found

  // A slider always looks answered, so make it one. Without this the handle
  // sits on "Up to 60 minutes" while the stored answer is still null, and the
  // questionnaire refuses to advance past a question that looks filled in.
  useEffect(() => {
    if (found === -1) onChange(TRAVEL_OPTIONS[TRAVEL_DEFAULT_INDEX].id)
  }, [found, onChange])

  return (
    <fieldset className="border-0 p-0">
      <legend className="eyebrow mb-3">How far are you willing to travel?</legend>

      <p className="mb-3 text-sm text-fg">{TRAVEL_OPTIONS[index].label}</p>

      <input
        type="range"
        min={0}
        max={TRAVEL_OPTIONS.length - 1}
        step={1}
        value={index}
        onChange={(e) => onChange(TRAVEL_OPTIONS[Number(e.target.value)].id)}
        aria-label="How far are you willing to travel?"
        aria-valuetext={TRAVEL_OPTIONS[index].label}
        className="w-full accent-gold"
      />

      <div className="mt-1 flex justify-between text-xs text-dim">
        <span>{TRAVEL_OPTIONS[0].label}</span>
        <span>{TRAVEL_OPTIONS[TRAVEL_OPTIONS.length - 1].label}</span>
      </div>

      <p className="mt-3 text-xs text-dim">{TRAVEL_CAVEAT}</p>
    </fieldset>
  )
}
