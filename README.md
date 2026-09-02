# AMAZING

A private, invitation-only professional network. Nobody signs up on their own: an
administrator creates **connectors**, and connectors are the only people who can
bring **members** in.

```
admin ──creates──▶ connector ──invites──▶ member
        claim code              invite code
```

- **Admin** — creates connectors, sets their invitation capacity, moves anyone
  through the membership statuses, reads the public waitlist, and sees the notes
  connectors chose to share.
- **Connector** — holds a budget of invitations, mints and disables codes, sees
  everyone who joined on them, and keeps private notes on each person.
- **Member** — sees who invited them, the code they joined with, and the profile
  the network reads them by.

---

## Stack

Vite · React 19 · TypeScript · React Router 7 · Tailwind CSS 4 · Supabase (Postgres + Auth)

The browser holds only the publishable key. Every privileged write goes through a
`SECURITY DEFINER` Postgres function behind row level security, so there is no
service-role key anywhere in the client — which is what makes this repo safe to
keep public.

---

## Running it

```bash
npm install
cp .env.example .env      # fill in the two values from Supabase → Project Settings → API
npm run dev               # http://localhost:5173
```

| Variable | Where to find it |
| --- | --- |
| `VITE_SUPABASE_URL` | Project Settings → API → Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Project Settings → API → `publishable` key |

### One manual step in Supabase

**Authentication → Sign In / Providers → Email → turn off "Confirm email".**

With confirmation on, `signUp` returns no session, so a new connector or member
cannot be signed in to redeem their code and the join flow stops with an
explanatory message. The Supabase CLI cannot change this setting without elevated
account privileges, so it has to be flipped in the dashboard.

---

## Database

Migrations live in `supabase/migrations` and are applied with:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

### Schema

Six tables come straight from the ERD:

| Table | Holds |
| --- | --- |
| `profiles` | One row per authenticated person, any role. Keyed to `auth.users`. |
| `connectors` | The invite-granting layer; one row per connector profile. |
| `invite_codes` | Codes a connector hands out, with use counts. |
| `connector_user_links` | Provenance: which connector brought which member in. |
| `connector_notes` | A connector's private context on someone they invited. |
| `search_documents` | Semantic search substrate. Created with pgvector; the MVP writes no embeddings. |

Three tables were added because the MVP needs them:

| Table | Why it exists |
| --- | --- |
| `waitlist_entries` | The public landing page collects name/email/LinkedIn from people who have no auth account, so this cannot live in `profiles`. |
| `connector_invitations` | `connectors.profile_id` is `NOT NULL`, but an admin creates a connector *before* that person has an account. This staging row holds the claim code until it is redeemed into a real profile + connector pair. |
| `admin_allowlist` | Admins have no invitation code. An email listed here is promoted to an admin profile automatically on first signup. |

### Invitation capacity

Capacity is spent when someone **actually joins**, not when a code is issued. A
connector with 8 invitations may shape those into one shared code, eight single
codes, or anything between; `redeem_code` enforces the ceiling. (An earlier model
reserved capacity per live code, which deadlocked a connector out of ever minting
a second one — see `20260902000002_capacity_on_join.sql`.)

### Functions

| Function | Caller | Does |
| --- | --- | --- |
| `lookup_code` | anon | Describes a code on the join screen without revealing anything else. |
| `redeem_code` | new user | Turns a bare auth account into a member or connector atomically. |
| `create_connector_invitation` | admin | Stages a connector and returns the claim code. |
| `create_invite_code` | connector | Mints a code out of remaining capacity. |
| `set_invite_code_status` | connector | Disables or re-activates one of their own codes. |

---

## Routes

| Path | Access | Purpose |
| --- | --- | --- |
| `/` | public | Landing page and waitlist |
| `/join` | public | Redeem a claim code or an invitation code, then sign up |
| `/signin` | public | Returning members |
| `/admin-setup` | unlisted | First-run account creation for an allowlisted admin |
| `/onboarding` | authenticated | Profession and self-description |
| `/admin` | admin | Administration |
| `/connector` | connector | People, notes, and invitation codes |
| `/home` | member | Who invited you, your code, your profile |

---

## Security model

Verified by `scripts/check-rls.mjs`, which asserts against the live project:

- A member sees only themselves and the connector who invited them.
- A member cannot read the notes written about them.
- An admin sees only notes a connector flagged as searchable.
- A member cannot promote themselves or clear their own status (enforced by the
  `protect_profile_fields` trigger, which strips those columns on update for
  anyone who is not an admin).
- Anonymous visitors can write to the waitlist but never read it.
- Only connectors can mint invitation codes; only admins can create connectors.

```bash
PUB=<publishable-key> SUPABASE_URL=<url> node scripts/check-rls.mjs
```

## Demo data

`scripts/seed-demo.mjs` builds a populated demo by driving the real code paths —
admin creates a connector, the connector claims their account and mints codes,
members join and are annotated. It needs the service-role key, which is used only
to pre-confirm the seeded emails so the script can run regardless of the email
confirmation setting.

```bash
SR=<service-role-key> PUB=<publishable-key> SUPABASE_URL=<url> node scripts/seed-demo.mjs
```
