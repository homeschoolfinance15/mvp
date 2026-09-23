import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Field, Input } from './ui'

/**
 * Just the account, or everything.
 *
 * Every screen that deletes an account asks the same question, so the words
 * live here once. The database decides what each answer removes —
 * delete_my_account(p_scope) and delete_managed_profile(p_profile_id,
 * p_scope) — and refuses anything else; this only asks.
 *
 * 'everything' is the one people cannot take back and cannot see the edges
 * of, so it is typed out, the way GitHub asks for a repository's name before
 * deleting it. The typed text is kept here and handed back with every
 * change, so a caller holds both and asks scopeConfirmed(scope, typed) before
 * enabling its confirm button. Unmounting (a closed Modal) clears it.
 */
export type DeleteScope = 'account' | 'everything'

export function scopeConfirmed(scope: DeleteScope, typed: string): boolean {
  return scope === 'account' || typed.trim() === 'DELETE'
}

export function DeleteScopeChoice({
  value,
  onChange,
  subjectName,
  self,
}: {
  value: DeleteScope
  onChange: (scope: DeleteScope, typed: string) => void
  subjectName: string
  /** True when a person is deleting their own account: "your" rather than a name. */
  self: boolean
}) {
  const [typed, setTyped] = useState('')
  const whose = self ? 'your' : `${subjectName}'s`
  const hosts = self ? 'you host' : 'they host'
  const options: { scope: DeleteScope; title: string; detail: string }[] = [
    {
      scope: 'account',
      title: 'Delete the account',
      detail: `Removes ${whose} profile, login, posts, comments, messages, registrations and tickets. Events ${hosts} that nobody else is part of are deleted. Attendance and event feedback stay on the events, under an anonymous label instead of a name.`,
    },
    {
      scope: 'everything',
      title: 'Delete the account and everything in it',
      detail: `Also removes ${whose} attendance, feedback written about events and people, uploaded photos and videos, and notifications sent to others.`,
    },
  ]

  return (
    <div>
      <fieldset className="space-y-2 border-0 p-0">
        <legend className="sr-only">What to delete</legend>
        {options.map((option) => (
          <label
            key={option.scope}
            className={`flex cursor-pointer items-start gap-3 rounded-[6px] border px-4 py-3.5 transition-colors ${
              value === option.scope ? 'border-fg bg-raised' : 'border-line hover:border-line-strong'
            }`}
          >
            <input
              type="radio"
              name="delete-scope"
              value={option.scope}
              checked={value === option.scope}
              onChange={() => onChange(option.scope, typed)}
              className="mt-1 accent-[#1f5c56]"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-fg">{option.title}</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted">{option.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <p className="mt-4 text-xs leading-relaxed text-muted">
        Payment records are kept, without {self ? 'your' : 'their'} name, for seven years because
        accounting law requires it. Nothing that belongs to anybody else is deleted: an event other
        people are part of has to be handed to another host before {self ? 'your' : 'this'} account
        can be deleted.
      </p>

      {value === 'everything' && (
        <div className="mt-4">
          <Field label="Type DELETE to confirm">
            <Input
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value)
                onChange(value, event.target.value)
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </div>
      )}
    </div>
  )
}

/**
 * Uploaded photos and video live in storage under `{uid}/`, which SQL cannot
 * delete (storage.protect_delete), so the browser removes them through the
 * Storage API. It has to happen before the account goes: afterwards the
 * bucket's policies no longer recognise the person. The owner, an
 * administrator, or the connector who invited them may delete, and 'everything'
 * refuses in the database while any file is left, so a failure here surfaces
 * as that refusal.
 *
 * The files go before the database can refuse for another reason (a hosted
 * event other people are part of, a refund in flight), and would then be gone
 * with the account still open. Only 'everything' calls this, which asked for
 * them to go either way.
 *
 * ponytail: one page of 1,000 objects. Loop on the list if anybody ever
 * uploads more than that.
 */
export async function removeMediaOf(profileId: string): Promise<void> {
  const { data } = await supabase.storage.from('media').list(profileId, { limit: 1000 })
  const paths = (data ?? []).map((object) => `${profileId}/${object.name}`)
  if (paths.length > 0) await supabase.storage.from('media').remove(paths)
}
