export type AppRole = 'user' | 'connector' | 'admin'

export type ProfileStatus =
  | 'pending'
  | 'active'
  | 'under_review'
  | 'restricted'
  | 'suspended'
  | 'removed'

export type ConnectorStatus = 'active' | 'limited' | 'paused' | 'removed'

export type InviteCodeStatus = 'active' | 'disabled' | 'exhausted' | 'expired'

export interface Profile {
  id: string
  role: AppRole
  full_name: string
  email: string | null
  current_profession: string | null
  semantic_summary: string | null
  profile_status: ProfileStatus
  interests: string[]
  /** Object path in the media bucket. Null means fall back to initials. */
  avatar_path: string | null
  /** Optional. Not exposed through member_directory. */
  linkedin_url: string | null
  created_at: string
  /**
   * Embedded by the profile fetch so the router knows whether the
   * questionnaire is still owed. PostgREST returns an object for this
   * one-to-one, but older versions return a one-element array; read it
   * through `needsQuestionnaire`, which accepts both.
   */
  profile_answers?:
    | { completed_at: string | null }
    | { completed_at: string | null }[]
    | null
}

/**
 * What one member may see of another: name, profession, role, interests.
 * Served by the `member_directory` view, which deliberately omits email and
 * profile_status so the guarantee on the `profiles` table itself is unchanged.
 */
export interface DirectoryEntry {
  id: string
  full_name: string
  current_profession: string | null
  role: AppRole
  interests: string[]
  created_at: string
  avatar_path: string | null
}

/** One uploaded image or video, stored as an element of `posts.media`. */
export interface MediaItem {
  path: string
  mime: string
  kind: 'image' | 'video'
}

export interface Post {
  id: string
  author_id: string
  body: string
  media: MediaItem[]
  /** Set when the post is a note on an event rather than a plain feed post. */
  event_id: string | null
  /** Profile ids tagged in the body. See the mentions migration. */
  mentions: string[]
  created_at: string
}

export interface PostLike {
  post_id: string
  profile_id: string
  created_at: string
}

export interface PostComment {
  id: string
  post_id: string
  author_id: string
  body: string
  mentions: string[]
  created_at: string
}

/** One message in a connector's circle. */
export interface CircleMessage {
  id: string
  connector_id: string
  author_id: string
  body: string
  created_at: string
}

export type RsvpStatus = 'invited' | 'going' | 'declined'

export interface Event {
  id: string
  host_id: string
  title: string
  description: string | null
  location: string | null
  starts_at: string
  ends_at: string | null
  cover_path: string | null
  created_at: string
}

export interface EventInvitation {
  event_id: string
  profile_id: string
  status: RsvpStatus
  responded_at: string | null
  created_at: string
}

export type ReportKind = 'correction' | 'concern' | 'endorsement'
export type ReportStatus = 'open' | 'resolved' | 'dismissed'

export const REPORT_KINDS: ReportKind[] = ['correction', 'concern', 'endorsement']

/** Which part of a profile is being disputed. Free text in the database. */
export const REPORTABLE_FIELDS = [
  { value: 'current_profession', label: 'Profession' },
  { value: 'full_name', label: 'Name' },
  { value: 'interests', label: 'Interests' },
  { value: 'semantic_summary', label: 'Description' },
]

/**
 * A member's claim about another member's profile.
 *
 * Readable by the reporter, an admin, and the connector who invited the
 * subject — never by the subject themselves.
 */
export interface ProfileReport {
  id: string
  subject_id: string
  reporter_id: string
  kind: ReportKind
  field: string | null
  body: string
  status: ReportStatus
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
}

/**
 * One suggestion for one member, with the reason it was made.
 *
 * Exactly one of member_id / post_id / event_id is set. acted_at is the
 * feedback signal the next scheduled run learns from.
 */
export interface Recommendation {
  id: string
  profile_id: string
  member_id: string | null
  post_id: string | null
  event_id: string | null
  reason: string
  rank: number
  batch_id: string
  acted_at: string | null
  created_at: string
}

export type TagField =
  | 'current_focus'
  | 'desired_outcomes'
  | 'conversation_topics'
  | 'outside_work_interests'
  | 'strongest_skills'

/** One seeded catalog entry. Ids are frozen; labels may be edited. */
export interface ProfileTag {
  id: string
  field: TagField
  label: string
  position: number
}

/** The handoff storage contract, per tag field. */
export interface TagAnswer {
  selected_tag_ids: string[]
  custom_tags: string[]
}

export type GatheringKind = 'big_events' | 'intimate_dinners' | 'one_on_ones'

/**
 * Signup questionnaire answers.
 *
 * Readable by the member, their connector and admins. Never by another
 * member, which is why these live apart from profiles rather than as more
 * columns on it.
 */
export interface ProfileAnswers {
  profile_id: string
  current_focus: TagAnswer
  desired_outcomes: TagAnswer
  conversation_topics: TagAnswer
  outside_work_interests: TagAnswer
  strongest_skills: TagAnswer
  current_focus_details: string | null
  desired_outcomes_details: string | null
  current_project: string | null
  background: string | null
  room_contribution: string | null
  current_conversation_need: string | null
  curation_notes: string | null
  home_city: string | null
  travel_preference: string | null
  phone: string | null
  age_range: string | null
  gathering_preference: GatheringKind[]
  travels_often: boolean | null
  travel_destinations: string | null
  taxonomy_version: number
  completed_at: string | null
  updated_at: string
  created_at: string
}

export type NotificationKind =
  | 'mention'
  | 'comment'
  | 'like'
  | 'event_invited'
  | 'event_rsvp'
  | 'circle_message'
  | 'member_joined'
  | 'report_raised'
  | 'report_resolved'
  | 'recommendations'
  | 'waitlist_joined'

/**
 * Something worth telling somebody, inside the platform.
 *
 * Written only by database triggers, so a notification cannot be forged.
 * Exactly one of the source columns is set, or none at all when the
 * notification points at a screen rather than an object.
 */
export interface Notification {
  id: string
  profile_id: string
  kind: NotificationKind
  actor_id: string | null
  post_id: string | null
  comment_id: string | null
  event_id: string | null
  circle_message_id: string | null
  report_id: string | null
  waitlist_entry_id: string | null
  /**
   * Embedded by the bell's query. An applicant has no profile to look up in
   * the directory, so their name is read off the waitlist row itself.
   */
  waitlist_entries?: { full_name: string } | null
  read_at: string | null
  created_at: string
}

/** A row of the append-only audit trail. Admin-readable only. */
export interface ActivityLogEntry {
  id: number
  actor_id: string | null
  /** `<table>.<insert|update|delete>`, e.g. `profiles.update`. */
  action: string
  entity: string
  entity_id: string | null
  detail: Record<string, unknown> | null
  created_at: string
}

export interface Connector {
  id: string
  profile_id: string
  invite_status: ConnectorStatus
  invite_capacity: number
  created_at: string
}

export interface InviteCode {
  id: string
  connector_id: string
  code: string
  status: InviteCodeStatus
  max_uses: number
  use_count: number
  created_at: string
}

export interface ConnectorUserLink {
  id: string
  connector_id: string
  user_profile_id: string
  invite_code_id: string | null
  created_at: string
}

export interface ConnectorNote {
  id: string
  connector_id: string
  user_profile_id: string
  note_text: string
  is_searchable_by_admin: boolean
  created_at: string
}

export interface ConnectorInvitation {
  id: string
  full_name: string
  email: string
  invite_capacity: number
  claim_code: string
  claimed_at: string | null
  claimed_by: string | null
  created_by: string | null
  created_at: string
}

export interface WaitlistEntry {
  id: string
  full_name: string
  email: string
  linkedin_url: string | null
  created_at: string
  /** Set once an admin has vetted this person and handed them to a connector. */
  assigned_at: string | null
  assigned_connector_id: string | null
  assigned_code_id: string | null
  /** Set when an admin decided against them. Reversible; the answers stay. */
  declined_at: string | null
  declined_by: string | null

  // What they answered on the way in. Every one of these is optional: the form
  // asks for nothing past a name and an email.
  home_city: string | null
  travel_preference: string | null
  current_focus: TagAnswer
  desired_outcomes: TagAnswer
  conversation_topics: TagAnswer
  outside_work_interests: TagAnswer
  strongest_skills: TagAnswer
  current_focus_details: string | null
  desired_outcomes_details: string | null
  current_project: string | null
  background: string | null
  room_contribution: string | null
  current_conversation_need: string | null
  curation_notes: string | null
}

/** Shape returned by the `lookup_code` RPC on the /join screen. */
export type CodeLookup =
  | {
      valid: true
      kind: 'connector_claim'
      full_name: string
      email: string
      invite_capacity: number
    }
  | { valid: true; kind: 'user_invite'; connector_name: string; remaining: number }
  | { valid: false; kind: 'connector_claim' | 'user_invite' | 'invalid'; reason: string }

/** Shape returned by the `redeem_code` RPC immediately after signup. */
export type RedeemResult =
  | { role: 'connector'; connector_id: string; invite_code: string }
  | { role: 'user'; connector_id: string }

export const PROFILE_STATUSES: ProfileStatus[] = [
  'pending',
  'active',
  'under_review',
  'restricted',
  'suspended',
  'removed',
]

export const CONNECTOR_STATUSES: ConnectorStatus[] = ['active', 'limited', 'paused', 'removed']
