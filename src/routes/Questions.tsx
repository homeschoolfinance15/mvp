import { useNavigate } from 'react-router-dom'
import { DashboardShell } from '../components/DashboardShell'
import { QuestionnaireForm } from '../components/QuestionnaireForm'
import { homePathFor, useAuth } from '../context/AuthProvider'
import { INTRO } from '../lib/questionnaire'

/**
 * The questionnaire as its own screen, reached after the account exists.
 *
 * Separate from Onboarding, which collects the profession and name the
 * network reads somebody by. This is the curation questionnaire, and it is
 * long enough to deserve its own page rather than being bolted onto that one.
 */
export default function Questions() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  if (!profile) return null

  return (
    <DashboardShell title="Let's find your people" caption={INTRO}>
      <div className="mx-auto max-w-2xl">
        <QuestionnaireForm
          profileId={profile.id}
          mode="signup"
          onComplete={() => navigate(homePathFor(profile), { replace: true })}
        />
      </div>
    </DashboardShell>
  )
}
