# Security controls and the road to SOC 2

## Read this first

**This platform is not SOC 2 compliant, and no amount of code will make it so.**

SOC 2 is an audit of an *organisation* by a licensed CPA firm, not a property
of a schema. It examines policies, hiring, vendor agreements, incident
history, and evidence collected over time. A Type I report says controls were
designed properly on one day; a Type II says they operated properly over three
to twelve months. Neither can be produced by writing SQL.

What this document does is smaller and honest: it maps the Trust Services
Criteria to what the code actually enforces, so that when an auditor asks, the
answer is a file path rather than a hope — and so the gaps are written down
instead of discovered late.

Nobody should describe this platform as SOC 2 compliant, in a pitch or on a
website, until an auditor has said so.

---

## What the code enforces today

### CC6.1 — Logical access, least privilege

Every table has row level security. The browser holds only a publishable key;
there is no service-role key in any client build. Every privileged write goes
through a `SECURITY DEFINER` function, and table grants are issued per table
and per operation rather than wholesale.

Two gates decide everything: `is_member()` (a profile that isn't suspended or
removed) and `can_post()` (an active profile).

Verified by `scripts/check-rls.mjs`, which asserts against a live project.

### CC6.1 — Data minimisation between members

The strongest control in the codebase. `profiles` holds email, self-
description and sanction status, and a member can read exactly two rows of it:
their own and their connector's. The feed needs to name an author, so
`member_directory` exposes name, profession, role and interests — and nothing
else. Widening the feed did not widen anybody's email.

Measured across six accounts in two circles: members read 2 profile rows,
7 directory rows.

### CC6.7 — Encryption

In transit and at rest, provided by Supabase. Not independently verified here;
their own SOC 2 report is the evidence, and belongs in the vendor file below.

### CC7.2 — Monitoring and audit

`activity_log` records every insert, update and delete across eleven tables,
written by a database trigger rather than by application code — so it cannot
be forgotten at a call site and still catches a change made directly against
the database. Updates record only the columns that changed, with before and
after values.

Nothing may insert into it: there is no insert policy and no insert grant.
The only writer is the definer trigger. Reading is admin-only.

Free text is deliberately excluded — message bodies, report bodies, private
notes. An audit trail should record that something happened, not become a
second copy of every conversation.

### CC8.1 — Change management

The whole schema is ordered SQL in `supabase/migrations`, applied by CI on
merge to `main`. Migrations are append-only. Every change arrives through a
pull request with a build gate.

### P4 / retention — how long things are kept

`purge_activity_log()` deletes audit rows older than 548 days (18 months),
refuses a window shorter than 30 days, is admin-only, and records its own
execution. A log that can be quietly trimmed is not evidence of anything.

**It is not yet scheduled.** Retention is enforced when someone runs it.

### P5 / erasure and access — a person's own data

- `export_my_data()` returns everything held about the caller as one JSON
  document, and the UI offers it as a download.
- `delete_my_account()` closes the caller's own account. Foreign keys cascade
  through every table; the audit trail keeps the event and loses the actor,
  because `activity_log.actor_id` is `ON DELETE SET NULL`.

Both deliberately exclude reports *about* the person: returning those would
name the reporter and undo the rule the trust layer depends on.

### Authentication

- Minimum password length 12, mixed case, digits and symbols required, and
  enforced by the auth server rather than only by the form. Verified: 8
  characters, 12 lowercase-only and 12 without a symbol are all refused.
- A signed-in person can change their password, and the app re-authenticates
  before it does. `secure_password_change` enforces the same server side.
- A forgotten password can be recovered, and the request answers identically
  for an address that exists and one that does not, so the form cannot be
  used to test who is a member.
- JWTs expire in an hour; refresh token rotation is on with a 10 second reuse
  interval.
- TOTP is enabled at the backend. **There is no enrolment screen, so nobody
  has MFA.** See gaps.

---

## Gaps — what an auditor will ask for and we do not have

Ordered by how much they matter.

| # | Gap | Kind | Notes |
|---|-----|------|-------|
| 1 | **No MFA in practice** | code | TOTP is enabled server-side but there is no enrolment UI. Administrators can move anybody's status and read every circle; that account should not be one password away. Build this first. |
| 2 | **Retention not scheduled** | code | `purge_activity_log()` exists and nothing calls it. A weekly workflow, like the recommender's, would close it. |
| 3 | **No read logging** | code | The log records changes, not access. An admin reading every circle conversation leaves no trace. For a platform whose substance is what people say about each other, that is the most defensible thing left to add. |
| 4 | **No privacy policy or terms** | organisational | Members are not told what is collected, who can see it, or how long it is kept. The trust layer in particular — that another member can file a report they will never see — is not disclosed anywhere. |
| 5 | **No signed vendor agreements** | organisational | Personal data reaches Supabase (hosting, auth, storage), Anthropic (recommendations), Hostinger (static files), Photon/komoot (city lookup) and Google Workspace (mail). Each needs a DPA and a subprocessor entry. Supabase and Anthropic both publish SOC 2 reports; collect them. |
| 6 | **No incident response plan** | organisational | Who is called, how members are notified, within what window. |
| 7 | **No access review** | organisational | Nobody periodically re-checks who is an admin. `admin_allowlist` is a table nobody audits. |
| 8 | **No backup restore test** | organisational | Supabase backs up; nobody has proven a restore works. |
| 9 | **No penetration test** | organisational | Expected for Type II. |
| 10 | **No production SMTP** | config | Supabase's built-in mailer is rate limited to a few messages an hour and is not for production, so password recovery effectively does not work for real users yet. A transactional provider is needed, plus SPF, DKIM and DMARC on goamazing.ai. The provider then becomes another subprocessor for row 5. |
| 11 | **Leaked-password protection off** | config | A dashboard setting in hosted Supabase (Auth → Password security), not in `config.toml`. |
| 12 | **`.local/hosting.md` holds SSH details** | practice | Gitignored and never committed, but it is a plaintext credential file on a laptop. A password manager is the right home. |

Items 4 through 9 are the bulk of a SOC 2 engagement and none of them are
engineering work.

---

## What data this platform holds

Worth stating plainly, because you cannot write a privacy policy without it.

| Data | Where | Who can read it |
|------|-------|-----------------|
| Name, profession, interests, photo | `profiles`, `member_directory` | every member |
| Email | `profiles` | the person, their connector, admins |
| Self-description | `profiles` | the person, their connector, admins |
| Posts, comments, likes | `posts`, `post_comments`, `post_likes` | every member |
| Uploaded images and video | private storage bucket | every member, via signed URLs |
| Circle conversations | `circle_messages` | that circle, and admins |
| A connector's private notes | `connector_notes` | that connector; admins only if shared |
| Reports filed about a person | `profile_reports` | the reporter, their connector, admins — **never the subject** |
| Recommendations and what was acted on | `recommendations` | the person it is for |
| Waitlist submissions | `waitlist_entries` | admins |
| Audit trail | `activity_log` | admins |

Profile and post text is sent to Anthropic when recommendations run. That is a
subprocessor disclosure, and it belongs in the privacy policy.

What somebody types into the city field reaches Photon, an open geocoder run
by komoot, one debounced request at a time while they type. It is a city
lookup and nothing more: only city-level layers are requested, so a street
address cannot come back even if one is typed, and no account or profile
identifier is sent with the query. It is still a subprocessor and belongs in
the same disclosure. Self-hosting Photon removes it entirely, and the only
change would be a URL in `src/lib/cities.ts`.

---

## Suggested order

1. MFA enrolment, starting with administrators.
2. Schedule the retention purge.
3. Privacy policy and terms, using the table above.
4. Collect DPAs and subprocessor SOC 2 reports.
5. Read logging for admin access to circles and reports.
6. Then talk to an auditor about readiness.
