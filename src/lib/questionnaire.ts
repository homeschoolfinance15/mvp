import type { TagField, TagAnswer } from './types'

/**
 * The signup questionnaire, transcribed from the developer handoff.
 *
 * Every label, helper, placeholder and limit here comes from that document.
 * Keeping them in one file means the form, the profile editor and the
 * validation cannot drift from each other or from the spec.
 *
 * Question numbers match the handoff's original list, which has no Q8. They
 * are never shown to a member: "Do not display these numbers or internal
 * field keys to members."
 *
 * One correction to the source: the document spells the product "Amaizing"
 * throughout. It is AMAZING.
 */

export const INTRO =
  'Tell us a little about yourself so we can help find the right rooms for you. You can update your answers anytime.'

export const DISCLOSURE =
  'Your answers help AMAZING and your community connector curate relevant gatherings. They are not shown to other members. If you join the waitlist, an assigned connector can view them once you are placed in a community.'

/** Shown under the two preference questions, per the handoff. */
export const PREFERENCE_CAVEAT =
  'These answers describe preferences; they do not guarantee introductions, funding, clients, or invitations.'

/**
 * The order the handoff specifies, and it is explicit about it: "After the
 * existing account and location fields, show the five initial questions below
 * in order."
 *
 *   Initial   location and practical fields, then Q0, Q1, Q3, Q5, Q7
 *   Later     Q2, Q4, Q6, Q9, Q10
 *
 * Rendering all the tag questions and then all the text ones is easier and
 * wrong: it puts Q1 fifth and Q10 first.
 */
export const INITIAL_ORDER = [
  'current_focus',           // Q0
  'current_project',         // Q1
  'desired_outcomes',        // Q3
  'conversation_topics',     // Q5
  'outside_work_interests',  // Q7
] as const

export const LATER_ORDER = [
  'background',                // Q2
  'room_contribution',         // Q4
  'current_conversation_need', // Q6
  'curation_notes',            // Q9
  'strongest_skills',          // Q10
] as const

export interface TagQuestion {
  field: TagField
  /** Q0, Q3, Q5, Q7, Q10 — for our reference only, never rendered. */
  number: string
  prompt: string
  helper: string
  min: number
  max: number
  /** "Custom tags. Enable only for Q5, Q7, and Q10." */
  allowCustom: boolean
  /** '"Something else". Available only for Q0 and Q3.' */
  detailsField?: 'current_focus_details' | 'desired_outcomes_details'
  detailsPrompt?: string
  detailsPlaceholder?: string
  stage: 'initial' | 'more'
}

export interface TextQuestion {
  field:
    | 'current_project'
    | 'background'
    | 'room_contribution'
    | 'current_conversation_need'
    | 'curation_notes'
  number: string
  prompt: string
  helper: string
  placeholder: string
  maxLength: number
  required: boolean
  stage: 'initial' | 'more'
}

export const TAG_QUESTIONS: TagQuestion[] = [
  {
    field: 'current_focus',
    number: 'Q0',
    prompt: 'What are you focused on accomplishing right now?',
    helper: 'Choose up to 3 priorities.',
    min: 1,
    max: 3,
    allowCustom: false,
    detailsField: 'current_focus_details',
    detailsPrompt: 'Tell us a little more.',
    detailsPlaceholder:
      "I'm opening a second restaurant and figuring out how to build the team.",
    stage: 'initial',
  },
  {
    field: 'desired_outcomes',
    number: 'Q3',
    prompt: 'What would make AMAZING worthwhile for you?',
    helper: 'What would you like to get out of the rooms you join?',
    min: 1,
    max: 3,
    allowCustom: false,
    detailsField: 'desired_outcomes_details',
    detailsPrompt: 'What would a great experience look like for you?',
    detailsPlaceholder: '',
    stage: 'initial',
  },
  {
    field: 'conversation_topics',
    number: 'Q5',
    prompt: 'What topics could you talk about for hours?',
    helper:
      "Choose up to 5. Specific topics are welcome, so add your own if you don't see it.",
    min: 1,
    max: 5,
    allowCustom: true,
    stage: 'initial',
  },
  {
    field: 'outside_work_interests',
    number: 'Q7',
    prompt: 'What do you enjoy outside of work?',
    helper: 'Choose up to 5 interests, or add your own.',
    min: 0,
    max: 5,
    allowCustom: true,
    stage: 'initial',
  },
  {
    field: 'strongest_skills',
    number: 'Q10',
    prompt: "What are up to three skills you're strongest in?",
    helper: "Choose up to 3 things you're good at. These can come from work or life.",
    min: 0,
    max: 3,
    allowCustom: true,
    stage: 'more',
  },
]

export const TEXT_QUESTIONS: TextQuestion[] = [
  {
    field: 'current_project',
    number: 'Q1',
    prompt: "What are you working on that you're excited about?",
    helper:
      "A project, a business, something you're learning, or a change you're making. One or two sentences is plenty.",
    placeholder: "I'm building software for local shops and learning how to sell it.",
    maxLength: 300,
    required: true,
    stage: 'initial',
  },
  {
    field: 'background',
    number: 'Q2',
    prompt: "What's your background, and how did you get here?",
    helper: 'Share a few experiences or an unexpected turn that shaped your path.',
    placeholder: 'I started in retail, moved into operations, and now run a small business.',
    maxLength: 600,
    required: false,
    stage: 'more',
  },
  {
    field: 'room_contribution',
    number: 'Q4',
    prompt: 'What could other people in the room come to you for?',
    helper:
      "An experience, skill, or perspective you're happy to share. You don't need to be an expert.",
    placeholder: "I've hired my first team and can share what I wish I had known.",
    maxLength: 300,
    required: false,
    stage: 'more',
  },
  {
    field: 'current_conversation_need',
    number: 'Q6',
    prompt: 'What would you love to compare notes with someone about right now?',
    helper:
      "Think of a specific question, challenge, or idea you'd enjoy discussing in person.",
    placeholder: 'How other business owners made their first management hire.',
    maxLength: 300,
    required: false,
    stage: 'more',
  },
  {
    field: 'curation_notes',
    number: 'Q9',
    prompt: 'Anything else we should know to help find the right room for you?',
    helper:
      'Share anything the other questions missed, including the kinds of gatherings where you feel most comfortable.',
    placeholder: "I'm new to the area and enjoy small groups with time for deeper conversation.",
    maxLength: 500,
    required: false,
    stage: 'more',
  },
]

/** Required, per the handoff's location section. */
export const TRAVEL_OPTIONS = [
  { id: 'up_to_30_min', label: 'Up to 30 minutes' },
  { id: 'up_to_60_min', label: 'Up to 60 minutes' },
  { id: 'up_to_90_min', label: 'Up to 90 minutes' },
  { id: 'open_to_longer_trips', label: 'Open to longer trips' },
]

/** Where the travel slider sits before anyone has answered. */
export const TRAVEL_DEFAULT_INDEX = 1

/**
 * Has this member finished the questionnaire's first stage?
 *
 * Reads the `profile_answers(completed_at)` embed that rides along with the
 * profile fetch. PostgREST returns an object for a one-to-one embed and older
 * versions return a one-element array; a gate that guesses wrong locks every
 * member out of the app, so accept both.
 */
export function questionnaireDone(
  embedded:
    | { completed_at: string | null }
    | { completed_at: string | null }[]
    | null
    | undefined,
): boolean {
  const one = Array.isArray(embedded) ? embedded[0] : embedded
  return Boolean(one?.completed_at)
}

export const TRAVEL_CAVEAT =
  'This indicates willingness to travel, not a routing guarantee.'

/** From the raw signup notes, which the handoff omitted. */
export const GATHERING_OPTIONS = [
  { id: 'big_events', label: 'Big events' },
  { id: 'intimate_dinners', label: 'Intimate dinners' },
  { id: 'one_on_ones', label: 'One on ones' },
]

export const AGE_RANGES = [
  '18-24',
  '25-34',
  '35-44',
  '45-54',
  '55-64',
  '65+',
  'Prefer not to say',
]

/** "Show the first 12 options initially, with 'Show all'." */
export const VISIBLE_BEFORE_SHOW_ALL = 12

export const EMPTY_TAG_ANSWER: TagAnswer = { selected_tag_ids: [], custom_tags: [] }

/**
 * Custom tag rules, verbatim: "Trim and collapse whitespace; accept 2-50
 * characters including spaces."
 */
export function normaliseCustomTag(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 50)
}

export function customTagProblem(
  raw: string,
  existing: TagAnswer,
  catalogLabels: string[],
): string | null {
  const value = normaliseCustomTag(raw)
  if (value.length < 2) return 'Use at least 2 characters.'

  const lower = value.toLowerCase()
  // "Match existing labels case-insensitively before creating a custom value."
  if (catalogLabels.some((l) => l.toLowerCase() === lower)) {
    return 'That one is already in the list. Choose it from there.'
  }
  // "Reject duplicates within the same field."
  if (existing.custom_tags.some((t) => t.toLowerCase() === lower)) {
    return "You've already added that."
  }
  return null
}

export function tagCount(answer: TagAnswer): number {
  return answer.selected_tag_ids.length + answer.custom_tags.length
}
