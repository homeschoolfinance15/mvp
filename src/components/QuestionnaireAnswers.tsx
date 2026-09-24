import { useState } from 'react'
import { isNetworkMember, useAuth } from '../context/AuthProvider'
import { MEMBER_DISCLOSURE } from '../lib/questionnaire'
import { QuestionnaireForm } from './QuestionnaireForm'
import { Button, SectionHeader } from './ui'

/**
 * The questionnaire on the profile page, collapsed until wanted.
 *
 * "All answers remain editable in the profile." It opens closed because it is
 * long, and somebody visiting their profile to change a photograph should not
 * have to scroll past thirty questions.
 */
export function QuestionnaireAnswers() {
  const { profile } = useAuth()
  const [open, setOpen] = useState(false)

  // Only members are curated by it: event-only accounts never had it, and
  // connectors and admins run the network rather than being placed in it.
  if (!profile || profile.role !== 'user' || !isNetworkMember(profile)) return null

  return (
    <section className="mt-12">
      <SectionHeader
        title="Your answers"
        caption={MEMBER_DISCLOSURE}
        action={
          <Button size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Edit answers'}
          </Button>
        }
      />
      {open && <QuestionnaireForm profileId={profile.id} mode="edit" />}
    </section>
  )
}
