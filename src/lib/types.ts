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
  created_at: string
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
