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

On top of that invitation graph the network runs as a place rather than a
directory: a shared feed with media, events anyone can RSVP to, a private room
per connector circle, a way for members to correct each other's profiles, and a
weekly set of recommendations written by Claude explaining who is worth meeting
and why.

| Surface | Who | What |
| --- | --- | --- |
| Feed | everyone | Posts with images and video, likes, comments. Network-wide. |
| Events | everyone | Anyone may RSVP; connectors and admins host. Each event has its own thread. |
| Circle | members and connectors | A room shared with everyone one connector brought in. |
| Raised | members raise, connectors act | Corrections and endorsements about another member's profile. |
| For you | everyone | Claude's weekly picks, each with the reason it was chosen. |

---

## Stack

Vite · React 19 · TypeScript · React Router 7 · Tailwind CSS 4 · Supabase (Postgres +
Auth + Storage + Realtime + Edge Functions) · Claude Opus 5

The browser holds only the publishable key. Every privileged write goes through a
`SECURITY DEFINER` Postgres function behind row level security, so there is no
service-role key anywhere in the client — which is what makes this repo safe to
keep public. The Anthropic key follows the same rule: it lives in a Supabase edge
function and is never shipped to a browser.

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

The shared surfaces added on top:

| Table | Holds |
| --- | --- |
| `posts` | Feed posts. `media` is a jsonb array of storage paths; `event_id` is set when the post is a note on an event. |
| `post_likes` | Composite primary key, so liking twice is a constraint violation rather than something the client checks. |
| `post_comments` | Flat. No threading until somebody asks for a reply to a reply. |
| `events` | Hosted by connectors and admins, visible to everyone. |
| `event_invitations` | One row per person per event, carrying both a host's invitation and a member's own RSVP. |
| `circle_messages` | The room shared by everyone one connector invited. |
| `profile_reports` | A member's claim about another member's profile. Never readable by its subject. |
| `recommendations` | Claude's picks for one member, each with the reason. |
| `activity_log` | Append-only audit trail, written by triggers, readable only by an admin. |
| `notifications` | Ten kinds of in-platform notice. Written only by triggers. |
| `profile_tags` | The five seeded tag catalogs from the signup handoff, 134 entries with frozen ids. |
| `profile_answers` | Questionnaire answers. The member, their connector and admins. Never another member. |

And one view:

| View | Why |
| --- | --- |
| `member_directory` | Name, profession, role, interests — network-wide. It exists so the feed can name an author **without** opening `profiles_select`, which also holds email and sanction status. |

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
| `assign_waitlist_entry` | admin | Vets a waitlist entry and mints a code for it out of a connector's capacity. |
| `is_member` | anyone | The read gate: a profile that isn't suspended or removed. |
| `can_post` | anyone | The write gate: an active profile. |
| `can_host_events` | anyone | Connectors and admins. |
| `my_circle_id` | anyone | Which connector's room you belong to. Null for admins, who were invited by nobody. |
| `connects_to` | connector | Whether the caller invited that profile. |
| `resolve_profile_report` | connector, admin | Closes a report. Exists because RLS can gate a row but cannot pin a column. |
| `log_activity` | trigger | Writes the audit trail. Nothing else may insert into it. |

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
| `/feed` | any member | The network-wide feed, with Claude's picks above it |
| `/events` | any member | Events, RSVP, invitations, per-event threads |
| `/circle` | any member | Your connector's room, live |
| `/questions` | any member | The signup questionnaire, and where onboarding sends people |
| `/profile` | any member | Edit your own record — members, connectors and admins alike |

---

## Security and compliance

[COMPLIANCE.md](COMPLIANCE.md) maps what the code enforces to the SOC 2 Trust
Services Criteria, and lists what is missing. Read the top of it before
describing this platform as compliant anywhere: SOC 2 is an audit of an
organisation, not a property of a schema, and several of the remaining gaps
are not engineering work.

## Security model

Verified by `scripts/check-rls.mjs`, which asserts against the live project:

- A member sees only themselves and the connector who invited them **in
  `profiles`**. The feed needs to put a name to an author, so `member_directory`
  exposes name, profession, role and interests network-wide — and nothing else.
  `profiles_select` is unchanged, so a member still cannot read another
  member's email. That separation is the whole reason the view exists.
- A member cannot read the notes written about them.
- An admin sees only notes a connector flagged as searchable.
- A member cannot promote themselves or clear their own status (enforced by the
  `protect_profile_fields` trigger, which strips those columns on update for
  anyone who is not an admin).
- Anonymous visitors can write to the waitlist but never read it.
- Only connectors can mint invitation codes; only admins can create connectors
  or assign someone off the waitlist.
- A member cannot read a report filed about them, and cannot resolve one.
- A member cannot speak into a circle they were not invited into.
- A member cannot post in somebody else's name, or write their own
  recommendations.
- Only an admin can read the activity log.

Deleting is confirmed everywhere it destroys something other people can see,
and every hover-only control stays visible on a touch device.

```bash
DEMO_PASSWORD=<pw> PUB=<publishable-key> SUPABASE_URL=<url> node scripts/check-rls.mjs
DEMO_PASSWORD=<pw> PUB=<publishable-key> SUPABASE_URL=<url> node scripts/check-questionnaire.mjs
```

## The recommender

`supabase/functions/recommend` asks Claude Opus 5, once a week, which people,
posts and events are worth each member's attention — and writes the reason
alongside the pick. Members see it as **For you** at the top of the feed.

It runs as an edge function rather than in the browser for the same reason
there is no service-role key in the client: the Anthropic key must never ship
to a browser. The scheduled caller authenticates with its own
`RECOMMEND_SECRET`, so the service-role key never leaves Supabase either.

**No embeddings, deliberately.** `search_documents` has held an unused pgvector
column since the first migration. It is the right substrate at scale and the
wrong tool at this size: a few hundred people fit in a prompt, and ranking them
directly produces the thing a cosine distance cannot — a sentence saying why two
people should talk. When the candidate set outgrows a prompt, `search_documents`
becomes the retrieval stage and `recommendations` does not change.

**What "it learns" means.** Nothing is trained. Each run is handed what that
member was shown last time and what they acted on, and adjusts in context.
Whether it is working is a query, not a feeling:

```sql
select * from public.recommendation_performance order by ran_at desc;
```

The candidate pool is identical for every member in a run, so it sits in a
cached prompt prefix — member two onward reads the bulk of it from cache.

```bash
supabase secrets set ANTHROPIC_API_KEY=... RECOMMEND_SECRET=...
supabase functions deploy recommend
```

## Deployment

See **[DEPLOY.md](DEPLOY.md)** before pushing to `main`. There is one ordering
trap: Hostinger deploys the frontend on push, the database does not follow
automatically, and getting that backwards takes the site down.

The frontend and the database deploy separately, from the same repo, on every
push to `main`.

| Piece | Lives on | Workflow |
| --- | --- | --- |
| Static site | Hostinger | **Hostinger Deployments**, which builds from `main` on the server. The FTP workflow in `.github/workflows/deploy-frontend.yml` has never run and should stay that way; see DEPLOY.md. |
| Schema, RLS, functions, edge functions | Supabase | `.github/workflows/deploy-database.yml` |
| Weekly recommendations | Supabase edge function | `.github/workflows/recommend.yml` |

### The database *is* in this repo

`supabase/migrations/` holds the whole schema as ordered SQL — tables, enums,
row level security, and every function. "Deploying the database" means replaying
the migrations the linked project has not applied yet, which is what
`deploy-database.yml` does with `supabase db push`.

Migrations are **append-only**. To change the schema, add a new file; editing an
applied one breaks the checksum in the remote migration history.

Keep the database on Supabase rather than moving it to Hostinger. Supabase is
not just Postgres here — it is also the auth server and the REST layer, and the
entire security model is Postgres row level security plus `SECURITY DEFINER`
functions. Hostinger's shared hosting offers MySQL, which has none of the
features this schema depends on (enums, `jsonb`, RLS policies, pgvector), is not
reachable from a browser, and provides no auth. Hostinger serves the built
static files; Supabase remains the backend.

### Required repository secrets

Settings → Secrets and variables → Actions.

| Secret | Used by | Where to find it |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | frontend build | Project Settings → API → Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | frontend build | Project Settings → API → `publishable` |
| `SUPABASE_ACCESS_TOKEN` | database | Account → Access Tokens → generate |
| `SUPABASE_PROJECT_REF` | database | The subdomain in your project URL |
| `SUPABASE_DB_PASSWORD` | database | Project Settings → Database → password |
| `FTP_SERVER` | Hostinger | hPanel → Files → FTP Accounts |
| `FTP_USERNAME` | Hostinger | same |
| `FTP_PASSWORD` | Hostinger | same |
| `FTP_SERVER_DIR` | Hostinger | optional; defaults to `/public_html/` |
| `RECOMMEND_SECRET` | recommendations | any random string; must match the value set with `supabase secrets set` |

`ANTHROPIC_API_KEY` is **not** a repository secret — it is set on the Supabase
function with `supabase secrets set`, so it never enters GitHub or a build.

The frontend build runs on pull requests too, so a broken build is caught before
merge. The FTP step is skipped until `FTP_SERVER` is set, so the workflow is
safe to merge before hosting is ready.

### After the domain is live

Add it to Supabase → Authentication → URL Configuration, as both the Site URL
and an allowed redirect URL.

`public/.htaccess` ships the SPA rewrite rules Apache needs; without it, routes
like `/join` and `/admin` return 404 on refresh.

## Demo data

`scripts/seed-demo.mjs` builds a populated demo by driving the real code paths —
admin creates a connector, the connector claims their account and mints codes,
members join and are annotated, then post to the feed, like and comment on each
other, RSVP to a dinner, talk in their circle, and raise one correction. It needs the service-role key, which is used only
to pre-confirm the seeded emails so the script can run regardless of the email
confirmation setting.

```bash
SR=<service-role-key> PUB=<publishable-key> SUPABASE_URL=<url> DEMO_PASSWORD=<pw> node scripts/seed-demo.mjs
```
