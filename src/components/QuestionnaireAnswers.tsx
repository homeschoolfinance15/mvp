import { useState } from 'react'
import { useAuth } from '../context/AuthProvider'
import { DISCLOSURE } from '../lib/questionnaire'
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

  if (!profile) return null

  return (
    <section className="mt-12">
      <SectionHeader
        title="Your answers"
        caption={DISCLOSURE}
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
