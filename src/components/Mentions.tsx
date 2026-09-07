import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { DirectoryEntry } from '../lib/types'
import { Initials } from './ui'

/**
 * Tagging people, and showing them tagged.
 *
 * Anyone on the platform can be named: members, connectors and admins alike.
 * The picker is fed from member_directory, which is the same roster the feed
 * already uses, so there is nothing here that a person could not have found
 * by scrolling.
 */

/**
 * Shown under a name when somebody has not filled in a profession. It has to
 * be their actual role: falling back to the word "Member" made connectors and
 * admins read as members in the picker.
 */
const ROLE_WORD: Record<string, string> = {
  admin: 'Administrator',
  connector: 'Connector',
  user: 'Member',
}

/** The "@sofia" being typed at the caret, if there is one. */
function activeQuery(value: string, caret: number): { query: string; from: number } | null {
  const before = value.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  // Only immediately after a space or at the very start, so an email address
  // does not open the picker.
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null
  const query = before.slice(at + 1)
  // A name, not a paragraph: stop offering once it is clearly not a mention.
  if (query.length > 30 || /\n/.test(query)) return null
  return { query, from: at }
}

export function useMentions(directory: Record<string, DirectoryEntry>) {
  const [mentioned, setMentioned] = useState<string[]>([])
  const people = useMemo(() => Object.values(directory), [directory])

  /** Only the ones whose names actually survived into the final text. */
  function resolve(body: string): string[] {
    return [...new Set(mentioned)].filter((id) => {
      const person = directory[id]
      return person && body.includes(`@${person.full_name}`)
    })
  }

  return { mentioned, setMentioned, people, resolve, reset: () => setMentioned([]) }
}

export function MentionPicker({
  value,
  caret,
  people,
  onPick,
}: {
  value: string
  caret: number
  people: DirectoryEntry[]
  onPick: (person: DirectoryEntry, from: number, query: string) => void
}) {
  const active = activeQuery(value, caret)
  if (!active) return null

  const matches = people
    .filter((p) => p.full_name.toLowerCase().includes(active.query.toLowerCase()))
    .slice(0, 6)

  if (matches.length === 0) return null

  return (
    <ul className="absolute z-20 mt-1 max-h-64 w-72 overflow-y-auto rounded-sm border border-line bg-ink shadow-xl">
      {matches.map((person) => (
        <li key={person.id}>
          <button
            type="button"
            // onMouseDown, because onClick fires after the textarea has
            // already lost focus and closed the picker.
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(person, active.from, active.query)
            }}
            className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-fg/[0.04]"
          >
            <Initials name={person.full_name} role={person.role} />
            <span className="min-w-0">
              <span className="block truncate text-sm text-fg">{person.full_name}</span>
              <span className="block truncate text-xs text-dim">
                {person.current_profession ?? ROLE_WORD[person.role] ?? 'Member'}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Inserts "@Full Name " at the caret, replacing what was being typed. */
export function applyMention(
  value: string,
  person: DirectoryEntry,
  from: number,
  query: string,
): { text: string; caret: number } {
  const inserted = `@${person.full_name} `
  const text = value.slice(0, from) + inserted + value.slice(from + 1 + query.length)
  return { text, caret: from + inserted.length }
}

/**
 * Renders a body with its mentions marked, and nothing else.
 *
 * Only names belonging to ids actually stored on the row are linked, so a
 * person cannot fake a mention by typing somebody's name, and a mention of
 * somebody who has since left simply reads as plain text.
 */
export function MentionText({
  body,
  mentions,
  directory,
  onOpen,
}: {
  body: string
  mentions: string[]
  directory: Record<string, DirectoryEntry>
  onOpen?: (person: DirectoryEntry) => void
}) {
  const people = (mentions ?? [])
    .map((id) => directory[id])
    .filter((p): p is DirectoryEntry => Boolean(p))
    // Longest first, so "@Ana Maria" wins over "@Ana".
    .sort((a, b) => b.full_name.length - a.full_name.length)

  if (people.length === 0) return <>{body}</>

  const nodes: ReactNode[] = []
  let rest = body
  let key = 0

  while (rest.length > 0) {
    let hitAt = -1
    let hit: DirectoryEntry | null = null

    for (const person of people) {
      const at = rest.indexOf(`@${person.full_name}`)
      if (at !== -1 && (hitAt === -1 || at < hitAt)) {
        hitAt = at
        hit = person
      }
    }

    if (!hit || hitAt === -1) {
      nodes.push(rest)
      break
    }

    if (hitAt > 0) nodes.push(rest.slice(0, hitAt))
    const person = hit
    nodes.push(
      <button
        key={`m-${key++}`}
        type="button"
        onClick={() => onOpen?.(person)}
        className="text-gold underline-offset-2 hover:underline"
      >
        @{person.full_name}
      </button>,
    )
    rest = rest.slice(hitAt + 1 + person.full_name.length)
  }

  return <>{nodes}</>
}

/** Tracks the caret so the picker knows what is being typed. */
export function useCaret() {
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement>(null)
  const [caret, setCaret] = useState(0)
  const sync = () => setCaret(ref.current?.selectionStart ?? 0)
  return { ref, caret, setCaret, sync }
}
