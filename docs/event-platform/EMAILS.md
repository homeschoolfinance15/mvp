# The email engine

Covers `EML-01` … `EML-11`. Two edge functions and a queue.

Nothing in the event platform sends an email directly. Everything **enqueues**
into `event_messages` + `event_message_recipients` (CONTRACT §3), and one
dispatcher drains the queue.

    caller ─────────POST──▶ event-email  ──writes──▶ event_messages
                                   │                 event_message_recipients
    schedule_event_messages() ─────┼──writes──▶ event_messages (no recipients)
                                   │                      │
                          _shared/audience.ts             │
                                   │                      │
    cron / pg_cron ──POST──▶ event-mailer ──claims────────┘──▶ Resend

Two producers write to `event_messages`: `event-email` for anything a person
or a UI asks for, and `schedule_event_messages()` in SQL for reminders and
feedback requests. **Only one of them writes recipients**, so the dispatcher
resolves the audience itself when a message arrives without one — see step 0
below. Both sides resolve through `supabase/functions/_shared/audience.ts`;
two resolvers that can disagree is how a message goes to nobody and reads as
though it went to everybody.

That split is not decoration. It is what makes three requirements possible at
all:

| | |
| --- | --- |
| `EML-06` | Claiming is one conditional `update` out of `scheduled`. Two overlapping runs cannot both take a message, so nobody gets two copies. |
| `EML-07` | The audience resolved at enqueue time is a starting point. Every recipient is re-checked at send time — still registered, not cancelled, event not cancelled, profile still active. |
| `EML-08` | Status is per recipient. A partial failure leaves the successes `sent` and only the failures `failed`, so a retry writes to the failures and to nobody else. |

Sending straight from the code that made the change can honestly do none of
the three.

---

## What each message says (EML-01)

One `MessageKind` per row. The wording lives in `WRITE` in
`supabase/functions/event-mailer/index.ts`, in the house voice — `Hello
{first},` … `— Amazing AI` — and in the same HTML `shell()` every other
message from Amazing arrives in.

| Situation | How triggered | Recipient | Message must make clear | Kind |
| --- | --- | --- | --- | --- |
| Free RSVP confirmed | Automatically after registration is confirmed | Attendee | Their place is confirmed; event details and ticket access. | `confirmation` |
| Paid ticket confirmed | Automatically after payment is confirmed | Purchaser/attendee | Amount/currency, payment status, ticket access, event details. Payment and ticket confirmation may be combined into one clear email. | `payment` |
| Upcoming event | Automatically according to that event's reminder settings | Currently confirmed attendee | Correct current time/location and ticket access. | `reminder` |
| Selected community member is invited | Automatically after an authorized organizer selects them and sends the invitation | Invited person | Event/host identity, invitation message if supplied, and a link to view, register, or buy a ticket while places remain. | `invite` |
| Address or other event details change | Organizer chooses to notify attendees from the change flow | Currently registered affected attendees | What changed, the replacement details, and a link to the current event page. | `update` |
| Attendee cancels | Automatically when cancellation is recorded | Attendee | Cancellation status and separate refund status. | `attendee_cancelled` |
| Refund update | Automatically when the refund status changes | Purchaser | Requested, processing, completed, or needs attention, matching the actual status. | `refund` |
| Event canceled | Automatically when event cancellation is confirmed | Affected attendees and anyone with an unresolved booking/payment obligation | Event will not happen and what happens to their booking/money. | `cancelled` |
| Feedback opens | Automatically at the configured feedback-opening time | Eligible participant | How to give feedback inside Amazing; submitted review content is never included. | `feedback_open` |

### One kind that is not in that table

| Kind | Sent when | Recipient | Must make clear |
| --- | --- | --- | --- |
| `cohost` | a host adds somebody as a cohost | that one person | they are hosting it, who asked them, when and where, and a link to the management screen |

EML-01 enumerates what the spec *requires*; it does not forbid more, and §13
excludes nothing relevant. This one is here because **it already existed and
worked** — the original `event-email` sent it, and dropping it in the move to
a queue would have deleted a working email that nobody decided to remove,
which is the regression QLT-06 exists to prevent. On the merits as well:
ORG-05 supports more than one named host, and a cohost can edit the event,
invite people, scan tickets and issue refunds. Being handed that without being
told is worse than being told.

The copy is the original's, unchanged. Only the link moved: a cohost goes to
`/manage/events/:id` rather than the public page, because managing it is the
thing they have just been given.

**A host is not a guest of their own event.** Anybody returned by
`event_host_ids` is filtered out of the `invite` audience, so somebody who is
both on the invite list and hosting hears `cohost` and not `invite` —
otherwise being made a cohost would arrive twice, as "you are hosting this"
and "you are invited to this", which contradict each other.

### The three audiences that are not "the people registered"

Each is its own query rather than a shared one:

**`payment` is the combined email, and `confirmation` is the free path.** The
paid row explicitly permits combining payment and ticket confirmation into
one, and `payment` already states the amount, that the place is confirmed, and
where the ticket is. So `event-email` **suppresses a `confirmation` for
anybody who has a `paid` order on that event** and replies
`{"message_id": null, "superseded_by": "payment"}`. One purchase, one email —
enforced here rather than by two workstreams agreeing which of the two to
call.

**`cancelled` reaches more than the registered.** "Anyone with an unresolved
booking/payment obligation" is three populations, none of which implies the
others: registrations at `confirmed` **or `pending`** (somebody mid-checkout is
exactly who most needs the email), orders at `pending` or `paid`, and anyone
with an `event_refunds` row still `requested` / `processing` /
`needs_attention` — which survives its order moving to `refunded` or
`cancelled`, and so is missed by any query that looks at orders alone. Deduped
by profile, so one person hears once.

**`feedback_open` reaches fewer.** FDB-06: "Buying a ticket, receiving an
invitation, or RSVPing alone is insufficient." The audience is
`event_attendance`, and the dispatcher re-checks attendance rather than
registration at send time — which also keeps a walk-in recorded by
`mark_attended` with no registration row. Mailing a no-show a link to a form
that will refuse them is the dead end QLT-02 exists to prevent.

**EML-10.** The structured facts — current time, current address, ticket link,
amount — are rendered as a table underneath the prose, never inside it. An
organiser writing "sorry, small change, see you there" on an `update` cannot
obscure a new start time, because the new start time is a separate row that
the organiser does not write.

**FDB-03 / EML-09.** `feedback_open` says feedback is open and how to give it.
It never carries a submitted answer, a rating, or whether anybody answered —
not even by way of the organiser's own `body` field, which that kind ignores.
There is a check for this.

**The money wording (CONTRACT §7.0).** An event's money belongs to whoever
created it: Amazing's own Stripe for a platform event, a super connector's own
account for theirs. The dispatcher is not told which, so `payment` and `refund`
name the event and its host, state what happened to the money, and never say
that Amazing took it or is returning it. There is a check for this too.

**"Sent" is the strongest word used anywhere here.** Resend's batch response
says it accepted the message. It does not say delivered and it does not say
read, so neither does this codebase (EML-08).

---

## `event-email` — the enqueue API

`POST {SUPABASE_URL}/functions/v1/event-email`

Resolves the audience, writes one `event_messages` row and one
`event_message_recipients` row per person, and stops. It does not call Resend.

Authorisation is the caller's own token, exactly as `invite-email` does it.
Addresses live on `profiles` and are read with the service role, which never
reaches a browser — `member_directory` deliberately has no email column, and
that is what keeps one member's address out of another member's hands.

### The body

```jsonc
{
  "kind": "reminder",            // required, one of the nine above
  "event_id": "uuid",            // required
  "profile_id": "uuid",          // the personal kinds; also narrows `invite` to one guest
  "subject": "string",           // invite, update (required on update)
  "body": "string",              // the organiser's own words: invite, update, cancelled
  "changed_details": {           // update — EML-04
    "starts_at": { "from": "2026-03-12T19:00:00Z", "to": "2026-03-12T20:00:00Z" }
  },
  "audience_count": 42,          // what the preview showed the organiser
  "reminder_id": "uuid",         // reminder — which event_reminders row this is
  "scheduled_for": "2026-03-12T18:00:00Z",  // default: now
  "send_now": true               // enqueue at now() and nudge the dispatcher
}
```

Per kind, what the organiser and attendee UIs actually send:

| Kind | Who may ask | Required | Also accepted |
| --- | --- | --- | --- |
| `confirmation` | service role only | `event_id`, `profile_id` | — |
| `payment` | service role only | `event_id`, `profile_id` | — |
| `refund` | service role only | `event_id`, `profile_id` | — |
| `reminder` | `hosts_event()` / `is_admin()` | `event_id` | `reminder_id`, `scheduled_for` |
| `invite` | `hosts_event()` / `is_admin()` | `event_id` | `profile_id`, `subject`, `body`, `send_now` |
| `cohost` | `hosts_event()` / `is_admin()` | `event_id`, `profile_id` | `send_now` |
| `update` | `hosts_event()` / `is_admin()` | `event_id`, `subject` | `body`, `changed_details`, `audience_count`, `send_now` |
| `cancelled` | `hosts_event()` / `is_admin()` | `event_id` | `body`, `send_now` |
| `attendee_cancelled` | the attendee, about themselves | `event_id`, `profile_id` | `send_now` |
| `feedback_open` | `hosts_event()` / `is_admin()` | `event_id` | `scheduled_for`, `profile_id` (one corrected guest — see below) |

`confirmation`, `payment` and `refund` are queued by `stripe-webhook` and
`event-refund` with the service role. Money is only ever confirmed by the
thing that moved it; a browser asking for a payment email would be asserting
something it cannot know, and gets a 403.

`attendee_cancelled` is the one an attendee triggers, and only with their own
`profile_id` — anything else falls through to the host check (EML-09).

### The reply

```jsonc
{ "message_id": "uuid", "kind": "update", "audience_count": 42,
  "scheduled_for": "2026-03-12T18:00:00Z", "status": "scheduled",
  "dispatched": true }
```

- `audience_count` in the reply is what was **actually queued**, re-resolved
  here. The `audience_count` in the request is what the preview showed the
  organiser; if they differ, the reply is the truth.
- Nobody to write to is a `200` with `message_id: null` and
  `audience_count: 0`, not an error. An event with no attendees yet is not a
  failure.
- `dispatched` says whether the `send_now` nudge reached the dispatcher. It is
  best effort: the message is queued either way and the schedule picks it up
  within five minutes regardless.

Two replies do not have that shape, and both are a `200`, not an error:

```jsonc
// confirmation, where the buyer already has a paid order for this event.
// The payment email is the confirmation — see EML-01 above.
{ "message_id": null, "audience_count": 0, "superseded_by": "payment" }

// feedback_open with a profile_id, where the request has already gone out.
// The corrected guest was added to the original message.
{ "message_id": "uuid", "audience_count": 1, "added": true,
  "reopened": true, "note": "Added to the original feedback request." }
```

### Behaviours worth knowing before you call it

**A stale update preview is refused (EML-04).** The organiser approved a
preview built against the event as it read a moment ago. If any field in
`changed_details` no longer matches what the event says now, the announcement
they approved is not the announcement that would go out, so it is refused:

```jsonc
// 409
{ "error": "The event changed again after this preview was built.",
  "stale": ["starts_at"], "refresh_preview": true }
```

Nothing is queued and nothing is lost. Build the preview again and ask again.

**`cohost` refuses somebody who does not host the event.** `409
{"error": "They do not host that event."}`. Add the `event_hosts` row first,
then send. The dispatcher re-checks it again at send time, so somebody removed
as a cohost between queueing and sending is dropped rather than told they are
hosting something they no longer host.

**Queue `cancelled` before you cancel the registrations.** The audience is
everybody holding a place, `confirmed` and `pending` alike, plus everybody
with money in flight. Cancel the registrations first and there is nobody left
to tell.

**A corrected check-in, after feedback already opened (FDB-06).** When a host
fixes a missed check-in, call `feedback_open` with that one `profile_id`.

- If the feedback request has **not** gone out yet, do nothing — the
  dispatcher's send-time re-check picks the correction up on its own. Calling
  anyway is harmless: the person is added to the message that is still
  waiting.
- If it **has** gone out, the one person is added to the **existing**
  `feedback_open` message and that message is re-opened to `scheduled`. It is
  never a second message, because a second message is a second audience and
  the only thing stopping it mailing everybody twice would be care. The
  dispatcher writes only to recipients still at `scheduled` or `failed`, so
  nobody who already had it gets another copy (EML-06, EML-08).
- Calling it twice for the same person replies
  `{"added": false, "note": "Already on this message."}`. Correcting
  attendance twice is not a fault.

A corrected guest must not stay blocked because the original check-in was
missed — and equally must not be the reason twenty other people get a second
email.

**Enqueuing never changes the event.** Saving an event and notifying the
people coming to it are two separate outcomes with two separate results
(ORG-10, EML-03). A failure here has never undone a saved change, a ticket or
a completed refund, and must not start (EML-08).

---

## `event-mailer` — the dispatcher

`POST {SUPABASE_URL}/functions/v1/event-mailer`

Deployed `--no-verify-jwt` so cron can reach it, which makes its own check the
only door:

- `x-mailer-secret: {MAILER_SECRET}` — how the schedules call it, or
- an `Authorization: Bearer` token belonging to an admin — how a person does.

Anything else is a 401.

What one run does:

0. **Resolves the audience when the message has none.** `schedule_event_messages()`
   writes the `event_messages` row in SQL, and nothing in SQL writes
   `event_message_recipients` — so every reminder and every `feedback_open`
   arrives here with an empty recipient set. The dispatcher resolves it using
   the same `_shared/audience.ts` resolver `event-email` uses, writes the
   rows, and sets `audience_count`.

   Three outcomes, and the distinction between the last two is the point:

   | Recipients on file | Kind | What happens |
   | --- | --- | --- |
   | one or more | any | dispatch to the ones still pending |
   | none | event-wide (`reminder`, `invite`, `update`, `cancelled`, `feedback_open`) | resolve, then dispatch |
   | none | about one person (`confirmation`, `payment`, `refund`, `attendee_cancelled`, `cohost`) | **`failed`**, never `sent` — the recipient's id lived only on the missing row, so nobody can recover it |

   "Resolved, and nobody qualified" is a legitimate `sent` with
   `audience_count: 0` — an event with nobody confirmed has nobody to remind.
   "Never resolved" is a fault. Conflating the two is what previously marked
   every scheduled reminder `sent` without an email being sent.

1. **Claims** every message with `status='scheduled'` and
   `scheduled_for <= now()` by moving it to `queued` in a single conditional
   update. A second run overlapping this one claims zero rows (EML-06).
2. **Skips** a message whose moment has passed wrongly — a reminder for an
   event that already started after a reschedule, a `feedback_open` whose
   `ends_at` moved later, anything but a cancellation or refund on a cancelled
   event. Marked `skipped`, never sent late (EML-06).
3. **Re-checks** every recipient (EML-07) and reads the address again, so a
   change of email between queueing and sending goes to the new one.
4. **Sends** one Resend message per person — never a shared `To`, never a
   `Cc`, so recipients never see each other (EML-05) — in chunks of 100,
   which is Resend's batch limit.
5. **Writes per-recipient status**, then rolls the message up to `sent` or
   `failed`.

Body is optional. `{}` or nothing sweeps everything due. `{"message_id":"…"}`
dispatches one message — and is also the retry: a named message is re-claimed
out of `failed` as well as `scheduled`, and only the recipients still sitting
at `failed` are written to. A plain sweep never picks failures up, because
retrying the same broken thing every five minutes for ever is not a retry.

---

## Initial timing settings (EML-11)

> "The development team supplies sensible initial timing values for
> Amazing-run events. Pre-event reminders remain editable through the
> organizer controls, and feedback requests follow the saved operational
> schedule. Show when messages are due so the organizer knows what will
> happen. Do not require the organizer to manually send each reminder or
> initial feedback request."

**Proposed, pending ratification. Every workstream uses these numbers.**

| Message | Initial value | Stored as | Editable by the organiser |
| --- | --- | --- | --- |
| Reminder, first | 7 days before `starts_at` | `event_reminders.minutes_before = 10080` | yes — change, disable, or add more |
| Reminder, second | 1 day before `starts_at` | `event_reminders.minutes_before = 1440` | yes |
| Reminders as a whole | on | `event_email_settings.reminders_enabled = true` | yes, one switch for the event (EML-02) |
| Feedback request | 2 hours after `ends_at` | `events.feedback_opens_after_minutes = 120` | yes |

Two rules that follow from the last sentence of EML-11, and are already true
of this engine:

- **Nothing here is sent by hand.** Every one of these is queued with a
  `scheduled_for` and drained by the dispatcher. The organiser is never the
  reason a reminder goes out.
- **A reminder that would land in the past is skipped, never sent late**
  (EML-06). A 7-day reminder on an event created three days beforehand is
  marked `skipped` on its first sweep rather than firing immediately. That is
  the intended behaviour, not a missed send — but it means the organiser
  screen showing "when messages are due" should read `event_messages` and show
  `skipped` as its own state, not fold it into "sent".

Whoever builds the organiser controls owns seeding these rows; this engine
sends whatever it is given. `reminders_enabled` is likewise honoured at the
point the reminder rows are queued, not here — the dispatcher sends what is in
the queue.

---

## Scheduling

Both triggers are shipped, per CONTRACT §6.

| Trigger | File | Interval | Live? |
| --- | --- | --- | --- |
| GitHub Actions | `.github/workflows/event-mailer.yml` | `*/5 * * * *` | **Yes**, once `MAILER_SECRET` and `VITE_SUPABASE_URL` are repository secrets. Skips cleanly while they are not. |
| `pg_cron` + `pg_net` | `supabase/migrations/` (the `db` workstream) | every minute | Only where the extensions are available on the project. |

**Running both is harmless.** Claiming is a single conditional update, so
whichever run gets there first owns the message and the other claims nothing
(EML-06). If both are live you get a sweep every minute with a five-minute
backstop, which is the arrangement to prefer.

A GitHub schedule is a request, not a promise — runs are delayed under load
and skipped on a quiet repository. That is why `*/5` rather than `*/1`, and
why anything an organiser is watching goes out through `send_now` instead of
waiting for a tick.

---

## Deploy

```bash
supabase functions deploy event-email
supabase functions deploy event-mailer --no-verify-jwt
```

`--no-verify-jwt` on the dispatcher is required: cron has no JWT. Its own
secret check is what stands in for one.

> `.github/workflows/deploy-database.yml` currently deploys only `recommend`.
> These two need the commands above by hand, or a line adding them to that
> workflow's *Deploy edge functions* step — it belongs to another workstream.

### Secrets

Set in Supabase, not in GitHub:

```bash
supabase secrets set RESEND_API_KEY=re_...
supabase secrets set MAILER_SECRET="$(openssl rand -hex 32)"
supabase secrets set SITE_URL=https://goamazing.ai   # optional, defaults to this
```

`MAILER_SECRET` is needed in two places and must be the same string in both:
in Supabase, where `event-mailer` checks it and `event-email` uses it for the
`send_now` nudge, and in GitHub → Settings → Secrets and variables → Actions,
where the schedule presents it.

| Secret | Where | Why |
| --- | --- | --- |
| `RESEND_API_KEY` | Supabase | the only thing that sends |
| `MAILER_SECRET` | Supabase **and** GitHub Actions | the dispatcher's only door |
| `SITE_URL` | Supabase | the links in the emails |
| `VITE_SUPABASE_URL` | GitHub Actions | where the schedule posts |

---

## Proving it

The pure decisions — audience filtering, the skip rules, the conditional
claim, the copy that must not say the wrong thing — are checked without a
database and without Resend:

```bash
deno check --node-modules-dir=none supabase/functions/_shared/audience.ts
deno check --node-modules-dir=none supabase/functions/event-mailer/index.ts
deno check --node-modules-dir=none supabase/functions/event-email/index.ts

deno run -A --node-modules-dir=none supabase/functions/event-mailer/index.ts --check
deno run -A --node-modules-dir=none supabase/functions/event-email/index.ts --check
```

`--node-modules-dir=none` is not optional. Without it Deno resolves the
`npm:` import through the repo's `node_modules`, which the Supabase edge
runtime does not have — so a clean run without the flag proves nothing about
what deploys.

Then a real dispatch run:

```bash
curl -fsS -X POST \
  "https://ppbpukefjvpwrwztsgyj.supabase.co/functions/v1/event-mailer" \
  -H "x-mailer-secret: ${MAILER_SECRET}" \
  -H 'content-type: application/json' \
  -d '{}'
```

```jsonc
{ "claimed": 3, "sent": 41, "failed": 0,
  "messages": [{ "message_id": "…", "status": "sent", "sent": 41, "failed": 0 }] }
```

Retry one message's failed recipients:

```bash
curl -fsS -X POST \
  "https://ppbpukefjvpwrwztsgyj.supabase.co/functions/v1/event-mailer" \
  -H "x-mailer-secret: ${MAILER_SECRET}" \
  -H 'content-type: application/json' \
  -d '{"message_id":"00000000-0000-0000-0000-000000000000"}'
```

Or from the Actions tab: **Event mailer** → Run workflow, with the message id
in the box, or blank for a sweep.

### Reading the queue afterwards

```sql
select kind, status, scheduled_for, sent_at, audience_count, error
from event_messages order by created_at desc limit 20;

-- who a given message actually reached, and who it did not
select status, count(*), min(error)
from event_message_recipients where message_id = '…' group by status;
```

`skipped` on a recipient is not a failure — it is EML-07 doing its job, and
the `error` column says which reason.
