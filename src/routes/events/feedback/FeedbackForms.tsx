import { Button, Field, Notice, Panel, Textarea } from '../../../components/ui'
import type { FeedbackQuestion } from '../../../lib/events'

/**
 * The two feedback forms, and the one control that renders either of them.
 *
 * FDB-16 is why nothing here knows what the questions say. The wording is
 * read from `feedback_questions` at runtime and an answer is stored against a
 * question id, so an answer always belongs to the question as it was actually
 * asked — reword a question next year and last year's answers still mean what
 * they meant. Only `answer_format` decides which control appears.
 */

export interface Answer {
  text: string
  choice: string | null
  scale: number | null
}

export const EMPTY_ANSWER: Answer = { text: '', choice: null, scale: null }

/** Answers for one form, keyed by question id. */
export type Draft = Record<string, Answer>

export function answerOf(draft: Draft, questionId: string): Answer {
  return draft[questionId] ?? EMPTY_ANSWER
}

export function isAnswered(answer: Answer): boolean {
  return Boolean(answer.text.trim() || answer.choice || answer.scale !== null)
}

export function anyAnswered(draft: Draft, questions: FeedbackQuestion[]): boolean {
  return questions.some((q) => isAnswered(answerOf(draft, q.id)))
}

/**
 * CONTRACT §5 gives Q2's three options in prose, and `feedback_questions` has
 * no column for them. They are the only choice question in the product, so
 * they live here until there is a second one.
 */
const CHOICES = ['Yes', 'Maybe', 'No']

/**
 * Notes we add around a question without touching its wording.
 *
 * Keyed by slot rather than by text, because the text is the database's to
 * change. FDB-04: the third peer question asks what somebody *would* like to
 * work on. Without this line people read it as "what did you work on
 * together?" and answer a question nobody asked.
 */
const PEER_HINTS: Record<number, string> = {
  3: 'Something you would be interested in doing together — not something you have already done.',
}

/**
 * FDB-14. Said before the button, on both forms, in the plainest words we
 * have. FDB-11: an administrator who happened to host or attend this event is
 * still an administrator, and pretending otherwise would be a lie told to
 * someone deciding how frankly to write.
 */
function Confidentiality() {
  return (
    <p className="text-xs leading-relaxed text-dim">
      Only Amazing administrators can read your answers, and they can see that you wrote
      them. This is not anonymous. An administrator who hosted or attended this event has the
      same access as any other administrator.
    </p>
  )
}

/* -------------------------------------------------------------------------- */
/* One question                                                                */
/* -------------------------------------------------------------------------- */

function QuestionControl({
  question,
  hint,
  answer,
  onChange,
}: {
  question: FeedbackQuestion
  hint?: string
  answer: Answer
  onChange: (next: Answer) => void
}) {
  if (question.answer_format === 'choice') {
    return (
      <fieldset className="border-0 p-0">
        <legend className="eyebrow mb-3">{question.wording}</legend>
        <ul className="flex flex-wrap gap-2">
          {CHOICES.map((choice) => {
            const chosen = answer.choice === choice
            return (
              <li key={choice}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  // Tapping the chosen one clears it. A mis-tap should be
                  // undoable without the person having to pick a different
                  // answer they do not mean (FDB-05).
                  onClick={() => onChange({ ...answer, choice: chosen ? null : choice })}
                  className={`rounded-sm border px-5 py-2 text-sm transition-colors ${
                    chosen
                      ? 'border-gold bg-gold-wash text-fg'
                      : 'border-line text-muted hover:text-fg'
                  }`}
                >
                  {choice}
                </button>
              </li>
            )
          })}
        </ul>
        <p className="mt-2.5 text-xs text-dim">
          {answer.choice
            ? `You chose ${answer.choice}. Tap it again to clear it.`
            : 'Leave this blank if you would rather not say.'}
        </p>
      </fieldset>
    )
  }

  if (question.answer_format === 'scale') {
    return <RatingSlider question={question} answer={answer} onChange={onChange} />
  }

  return (
    <Field label={question.wording} hint={hint ?? 'Optional.'}>
      <Textarea
        rows={3}
        value={answer.text}
        onChange={(e) => onChange({ ...answer, text: e.target.value })}
      />
    </Field>
  )
}

/**
 * The 1–10 rating of the event (FDB-08, QLT-04).
 *
 * The wording is the database's, not ours — not even in this comment, which
 * scripts/check-feedback-rules.mjs checks, because a pasted copy of a question
 * is how the screen and the stored answer start to drift apart (FDB-16).
 *
 * Built the way TravelSlider is — a native range input, labelled, with
 * aria-valuetext saying the value in words — but it cannot reuse that
 * component, which is bound to the questionnaire's travel options.
 *
 * It also has to solve the opposite of TravelSlider's problem. There, a
 * slider that looks answered was made answered. Here it must not be: a
 * rating nobody chose is not a 5, and quietly recording one would put a
 * number the respondent never gave in front of an administrator. So the
 * handle rests in the middle, the read-out says so, and the value stays null
 * until somebody moves it.
 */
function RatingSlider({
  question,
  answer,
  onChange,
}: {
  question: FeedbackQuestion
  answer: Answer
  onChange: (next: Answer) => void
}) {
  const chosen = answer.scale
  return (
    <fieldset className="border-0 p-0">
      <legend className="eyebrow mb-3">{question.wording}</legend>

      <div className="mb-3 flex items-baseline gap-3">
        <span className="text-4xl font-light tabular-nums text-fg">
          {chosen ?? '–'}
        </span>
        <span className="text-sm text-dim">
          {chosen === null ? 'No rating chosen yet' : 'out of 10'}
        </span>
      </div>

      <input
        type="range"
        min={1}
        max={10}
        step={1}
        value={chosen ?? 5}
        onChange={(e) => onChange({ ...answer, scale: Number(e.target.value) })}
        aria-label={question.wording}
        aria-valuetext={chosen === null ? 'No rating chosen yet' : `${chosen} out of 10`}
        className="w-full accent-gold"
      />

      <div className="mt-1 flex justify-between text-xs text-dim">
        <span>1 — poor</span>
        <span>10 — outstanding</span>
      </div>

      {chosen === null && (
        <p className="mt-3 text-xs text-dim">
          Drag the handle, or focus it and use the arrow keys, to choose a number.
        </p>
      )}
    </fieldset>
  )
}

/* -------------------------------------------------------------------------- */
/* One person                                                                  */
/* -------------------------------------------------------------------------- */

export function PeerForm({
  questions,
  draft,
  busy,
  error,
  onChange,
  onSubmit,
  onDidNotMeet,
  onBack,
}: {
  questions: FeedbackQuestion[]
  draft: Draft
  busy: boolean
  error: string
  onChange: (questionId: string, next: Answer) => void
  onSubmit: () => void
  onDidNotMeet: () => void
  onBack: () => void
}) {
  const answered = anyAnswered(draft, questions)

  return (
    <div className="space-y-5">
      {questions.map((question) => (
        <Panel key={question.id} className="px-5 py-5 sm:px-6">
          <QuestionControl
            question={question}
            hint={PEER_HINTS[question.slot]}
            answer={answerOf(draft, question.id)}
            onChange={(next) => onChange(question.id, next)}
          />
        </Panel>
      ))}

      {/*
        FDB-05. "I did not meet this person" is an answer, not a way out, so
        it sits at the same weight as sending — a room of sixty people is a
        room most of whom you never spoke to, and forcing a guess about a
        stranger produces feedback that is worse than none. It is also not
        the same as leaving the questions blank: blank means "nothing to say
        about someone I met", and the two are stored differently.
      */}
      <Panel className="px-5 py-5 sm:px-6">
        <p className="text-sm leading-relaxed text-muted">
          Did not speak to them? Say so, and we will stop asking. It is not counted
          against anyone.
        </p>
        <Button className="mt-4 w-full sm:w-auto" disabled={busy} onClick={onDidNotMeet}>
          I did not meet this person
        </Button>
      </Panel>

      <Confidentiality />

      <div aria-live="polite">{error && <Notice tone="error">{error}</Notice>}</div>

      <div className="flex flex-wrap gap-3">
        <Button onClick={onBack} disabled={busy}>
          Back to the list
        </Button>
        <Button variant="primary" className="flex-1" loading={busy} onClick={onSubmit}>
          {answered ? 'Send and continue' : 'Leave blank and continue'}
        </Button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* The event                                                                   */
/* -------------------------------------------------------------------------- */

export function EventForm({
  questions,
  draft,
  busy,
  error,
  onChange,
  onSubmit,
}: {
  questions: FeedbackQuestion[]
  draft: Draft
  busy: boolean
  error: string
  onChange: (questionId: string, next: Answer) => void
  onSubmit: () => void
}) {
  return (
    <div className="space-y-5">
      {questions.map((question) => (
        <Panel key={question.id} className="px-5 py-5 sm:px-6">
          <QuestionControl
            question={question}
            answer={answerOf(draft, question.id)}
            onChange={(next) => onChange(question.id, next)}
          />
        </Panel>
      ))}

      <Confidentiality />

      <div aria-live="polite">{error && <Notice tone="error">{error}</Notice>}</div>

      <Button
        variant="primary"
        className="w-full"
        loading={busy}
        disabled={!anyAnswered(draft, questions)}
        onClick={onSubmit}
      >
        Send my feedback on the event
      </Button>
    </div>
  )
}
