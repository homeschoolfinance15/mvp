import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from 'react'
import { Input } from './ui'

/**
 * EVT-03. The venue box, with Google's place predictions under it as the host
 * types — "The Corgi Cafe" offers the Corgi Cafes Google knows, each with its
 * address. Picking one fills venue and address; both stay ordinary, editable
 * fields afterwards, and typing without picking is never blocked.
 *
 * Places API (New) over plain fetch: two requests, no Maps script. One session
 * token spans the predictions and the pick, which Google bills as a single
 * autocomplete session. With no key configured this is exactly the plain input
 * it replaces.
 */

const KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
/** Whether venue search is switched on for this build. */
export const placesEnabled = Boolean(KEY)
const API = 'https://places.googleapis.com/v1'

interface Prediction {
  placeId: string
  main: string
  secondary: string
}

export interface PickedPlace {
  name: string
  address: string
}

export function PlaceInput({
  value,
  onChange,
  onPick,
  region,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string
  onChange: (value: string) => void
  onPick: (place: PickedPlace) => void
  /** Two-letter country to search in. Without one Google searches the world. */
  region?: string
}) {
  const listId = useId()
  const [predictions, setPredictions] = useState<Prediction[]>([])
  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)
  const session = useRef<string>(crypto.randomUUID())
  // Only what the host typed is searched: a value set by a pick must not
  // immediately open the list again.
  const typed = useRef(false)

  useEffect(() => {
    if (!KEY || !typed.current || value.trim().length < 3) {
      setPredictions([])
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API}/places:autocomplete`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY },
          body: JSON.stringify({
            input: value,
            sessionToken: session.current,
            ...(region ? { includedRegionCodes: [region] } : {}),
          }),
        })
        if (!res.ok) return setPredictions([])
        const body = (await res.json()) as {
          suggestions?: Array<{
            placePrediction?: {
              placeId: string
              structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } }
              text?: { text: string }
            }
          }>
        }
        const found = (body.suggestions ?? [])
          .map((s) => s.placePrediction)
          .filter((p): p is NonNullable<typeof p> => Boolean(p))
          .map((p) => ({
            placeId: p.placeId,
            main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
            secondary: p.structuredFormat?.secondaryText?.text ?? '',
          }))
        setPredictions(found)
        setActive(-1)
        setOpen(found.length > 0)
      } catch {
        // Aborted by the next keystroke, or offline: the box still types.
      }
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [value, region])

  async function pick(p: Prediction) {
    setOpen(false)
    typed.current = false
    try {
      const res = await fetch(
        `${API}/places/${encodeURIComponent(p.placeId)}?sessionToken=${session.current}`,
        { headers: { 'X-Goog-Api-Key': KEY!, 'X-Goog-FieldMask': 'displayName,formattedAddress' } },
      )
      const place = res.ok
        ? ((await res.json()) as { displayName?: { text: string }; formattedAddress?: string })
        : {}
      onPick({
        name: place.displayName?.text ?? p.main,
        address: place.formattedAddress ?? p.secondary,
      })
    } catch {
      onPick({ name: p.main, address: p.secondary })
    }
    // A pick ends Google's session; the next search starts a new one.
    session.current = crypto.randomUUID()
  }

  if (!KEY) return <Input {...rest} value={value} onChange={(e) => onChange(e.target.value)} />

  return (
    <div className="relative">
      <Input
        {...rest}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          typed.current = true
          onChange(e.target.value)
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => setOpen(predictions.length > 0)}
        onKeyDown={(e) => {
          if (!open) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => Math.min(a + 1, predictions.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(a - 1, 0))
          } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault()
            void pick(predictions[active])
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-[6px] border border-line bg-raised shadow-lg"
        >
          {predictions.map((p, i) => (
            <li
              key={p.placeId}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                void pick(p)
              }}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-4 py-2.5 text-sm ${i === active ? 'bg-fg/[0.06]' : ''}`}
            >
              <span className="block text-fg">{p.main}</span>
              {p.secondary && <span className="block text-xs text-muted">{p.secondary}</span>}
            </li>
          ))}
          <li role="presentation" className="px-4 py-1.5 text-right text-[10px] text-dim">
            Powered by Google
          </li>
        </ul>
      )}
    </div>
  )
}
