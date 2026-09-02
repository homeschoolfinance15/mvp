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
