/** Compare the facts an organiser previewed with the current saved event. */
export function staleChanges(
  changed: Record<string, { from: unknown; to: unknown }>,
  event: Record<string, unknown>,
): string[] {
  return Object.entries(changed)
    .filter(([field, change]) => field in event && normalise(field, event[field]) !== normalise(field, change?.to))
    .map(([field]) => field)
}

export function staleSnapshot(snapshot: Record<string, unknown>, event: Record<string, unknown>): string[] {
  const fields = ['title', 'slug', 'status', 'starts_at', 'ends_at', 'timezone', 'venue_name', 'address', 'location', 'attendee_instructions']
  return fields.filter((field) => !(field in snapshot) || normalise(field, snapshot[field]) !== normalise(field, event[field]))
}

function normalise(field: string, value: unknown): string {
  if (value == null) return ''
  const text = String(value)
  if (field === 'starts_at' || field === 'ends_at') {
    const time = Date.parse(text)
    if (!Number.isNaN(time)) return String(time)
  }
  return text.trim()
}

export function updateSubject(subject: unknown, title: unknown): string {
  return String(subject ?? '').trim() || `${String(title)} has changed`
}
