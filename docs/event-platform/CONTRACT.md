# Event platform — build contract

Single source of truth for the build described in *Amazing Event Platform
Developer Requirements* (10 Sep 2026). Every workstream builds against the
names below. **Nothing in here is negotiable without telling the primary
agent** — if a name is wrong or missing, say so rather than inventing a
second one.

Requirement tags (`ACC-01`, `BUY-05`, `EML-06` …) are the spec's. Cite them
in code comments where a rule is non-obvious.

---

## 0. Ground rules

- **Additive migrations only.** No `drop table`, no `drop column`, no
  destructive rewrite. These land on production with live data.
- **Existing behaviour is preserved.** `QLT-06`: login, profiles, connector
  relationships and network permissions must work exactly as before.
- **Style matches the repo.** Read a neighbouring file before writing.
  Heavy block comments explaining *why*, British English, no emoji.
- **`ponytail:` comments** mark deliberate shortcuts and name the ceiling.
- Money is integer minor units (`_cents`), never floats.
- Every non-trivial rule leaves one runnable check behind in `scripts/`.

---

## 1. The account model (ACC-01, ACC-02, ACC-05, ACC-06)

The single biggest change. Today `is_member()` means "has a profile", and it
is the read gate for the feed, the circle and the member directory. An
event-only account has a profile, so it would walk straight into all three.

**Split the gate in two:**

```
profiles.network_member  boolean not null default true   -- backfilled true
```

| Function | Means | Gates |
| --- | --- | --- |
| `has_account()` | profile exists, not suspended/removed | event surfaces: events, tickets, orders, feedback |
| `is_member()` | `has_account()` **and** `network_member` | everything it gates today, unchanged |

Existing rows all backfill to `true`, so no existing user changes state.
Event-only signup writes `false`. Redeeming an invite code flips it to
`true` on the **same profile row** (ACC-06 — no duplicate person).

---

## 2. Hosting permission (ACC-04, ORG-01A/B/C)

A **super connector** is the product name for a connector whose
`can_create_events` is true. It is a label, not a role — `app_role` is not
touched, because that enum is read by every policy, guard and dashboard in
the application and a naming change is not worth that blast radius.

```
connectors.can_create_events              boolean not null default false
connectors.events_permission_changed_by   uuid references profiles(id)
connectors.events_permission_changed_at   timestamptz

-- Stripe Connect. See §7 — we hold an account id, never a secret key.
connectors.stripe_account_id              text
connectors.stripe_connected_at            timestamptz
connectors.stripe_charges_enabled         boolean not null default false
connectors.stripe_payouts_enabled         boolean not null default false
connectors.stripe_account_status          text not null default 'none'
                                          -- none|pending|ready|restricted|disconnected
connectors.stripe_checked_at              timestamptz
```

Two distinct questions — do not merge them, ORG-01C depends on the split:

| Function | Means | Checked |
| --- | --- | --- |
| `may_create_events(p)` | admin, or connector with `can_create_events` | creating a draft, and the **first** publish |
| `may_host_events(p)` | admin, or any connector (existing meaning) | being named a host |
| `hosts_event(e)` | caller creates/co-hosts that event (existing) | every management action |

Turning the permission **off** blocks new creation and first publish only.
Editing, guests, invites, check-in, comms, refunds and results on an event
they already host all keep working.

---

## 3. Schema

New enums: `event_status`, `registration_status`, `order_status`,
`refund_status`, `message_status`, `feedback_outcome`.
New `notification_kind` values: `event_registered`, `event_updated`,
`event_cancelled`, `feedback_open`.

### events — extended, never replaced

Existing columns stay. Added:

```
status                event_status not null default 'draft'  -- existing rows -> 'published'
slug                  text unique not null                   -- EVT-01 shareable link
timezone              text not null default 'Europe/London'  -- EVT-02
venue_name            varchar
address               text
attendee_instructions text
refund_terms          text                                   -- BUY-15
capacity              int                                    -- null = unlimited (ORG-03)
registration_closed   boolean not null default false         -- ORG-03A, distinct from sold out
currency              char(3) not null default 'gbp'
payment_connector_id  uuid references connectors(id)         -- BUY-14, null = Amazing's own Stripe (BUY-13)
payment_recipient_id  uuid references profiles(id)           -- BUY-14 one recipient, never a split
published_at          timestamptz
cancelled_at          timestamptz
cancelled_by          uuid references profiles(id)
feedback_opens_after_minutes int not null default 120        -- FDB-15, editable
```

`event_status`: `draft | published | cancelled`.
"Finished" is derived from `ends_at`, not stored.

### New tables

| Table | Holds | Key rules |
| --- | --- | --- |
| `ticket_types` | `event_id, name, price_cents, currency, quantity, position, is_active` | ORG-04. All options share the event capacity. |
| `event_registrations` | `event_id, profile_id, ticket_type_id, status, hold_expires_at, confirmed_at, cancelled_at, cancelled_by, terms_snapshot` | **Partial unique index on `(event_id, profile_id) where status in ('pending','confirmed')`** — the anti-duplicate guard. |
| `event_orders` | `event_id, profile_id, registration_id, amount_cents, fee_cents, currency, status, stripe_checkout_session_id, stripe_payment_intent_id, stripe_account_id, idempotency_key, terms_snapshot, paid_at` | BUY-04: unique `idempotency_key` and unique session id stop double charges. |
| `event_refunds` | `order_id, amount_cents, status, stripe_refund_id, reason, requested_by, failure_message` | BUY-09: partial unique on `order_id where status in ('requested','processing','completed')` — same money never returned twice. |
| `event_tickets` | `registration_id (unique), event_id, profile_id, code, revoked_at, replaced_by` | BUY-10/11. `code = encode(gen_random_bytes(16),'hex')`, unguessable (QLT-05). |
| `event_attendance` | `event_id, profile_id, method('scan'/'manual'), ticket_id, recorded_by, recorded_at, corrected, reason` | Unique `(event_id, profile_id)` — ATT-03. Write policy is `hosts_event(event_id) or is_admin()`. `corrected=true` never fabricates a scan. |

> **Corrected 16 Sep.** This originally said "Manual requires `recorded_by <> profile_id` — ATT-06 no self check-in", which misread the requirement. ATT-06 says a **guest** cannot mark themselves attended; FDB-06 says a present host's attendance **must be recorded** even though they bought no ticket. A host running an event alone has nobody else to record them, so the column constraint made FDB-06 unsatisfiable for them. The rule belongs where `hosts_event()` can be asked — the insert policy and `mark_attended()` — and the policy version is *stricter*: `recorded_by <> profile_id` would still have let a guest write an attendance row naming a friend. Now a guest is refused whoever they name, and a host may record themselves.
| `event_invites` | `event_id, profile_id, invited_by, via_connector_id, message, send_status, resend_of` | ORG-08A/B. Partial unique `(event_id, profile_id) where resend_of is null`. A resend is a new row pointing at the first. |
| `feedback_questions` | `scope('peer'/'event'), slot, version, wording, answer_format, active` | FDB-16. Seeded at version 1 with the **exact** wording in §5. Answers reference a question id, never a slot. |
| `feedback_subjects` | `event_id, author_id, subject_id, outcome` | FDB-05. `feedback_outcome`: `pending / skipped / did_not_meet / submitted`. This is what distinguishes the four states. |
| `peer_feedback` | `event_id, author_id, subject_id, question_id, answer_text, answer_choice, submitted_at` | `check (author_id <> subject_id)`. Unique per `(event, author, subject, question)`. |
| `event_feedback` | `event_id, author_id, question_id, answer_scale, answer_text, submitted_at` | `answer_scale between 1 and 10`. Unique per `(event, author, question)`. |
| `event_email_settings` | `event_id pk, reminders_enabled, updated_by, updated_at` | EML-02. |
| `event_reminders` | `event_id, minutes_before, enabled` | Unique `(event_id, minutes_before)`. |
| `event_messages` | `event_id, kind, reminder_id, scheduled_for, status, subject, body, changed_details jsonb, audience_count, triggered_by, sent_at, error` | EML-08. `kind`: `confirmation / payment / reminder / invite / update / cancelled / attendee_cancelled / refund / feedback_open`. |
| `event_message_recipients` | `message_id, profile_id, email, status, error, sent_at` | Unique `(message_id, profile_id)` — EML-06 no duplicate copies. Retry touches only `status='failed'` — EML-08. |

`event_invitations` (the old RSVP table) is **kept and deprecated**. Backfill
forward: `status='going'` becomes a confirmed free `event_registrations` row
with a ticket; `status='invited'` becomes an `event_invites` row. A legacy
RSVP proves neither payment nor attendance (QLT-07) — no order, no
attendance row.

### RPCs / helper functions

| Name | Returns | Purpose |
| --- | --- | --- |
| `has_account()` | bool | §1 |
| `may_create_events(uuid)` | bool | §2 |
| `attended_event(uuid event, uuid profile)` | bool | FDB-06 eligibility |
| `event_capacity_state(uuid)` | `(capacity, confirmed, remaining, state)` | `state`: `open / sold_out / closed / cancelled / finished` (ORG-03A) |
| `register_free(uuid event, uuid ticket_type)` | registration row | BUY-02, capacity-safe |
| `cancel_registration(uuid registration)` | void | BUY-08, frees the place |
| `check_in(text ticket_code, uuid event)` | result enum | ATT-02: `ok / already / wrong_event / invalid / cancelled` |
| `mark_attended(uuid event, uuid profile, text reason)` | void | ATT-04/06 |

**Capacity safety (BUY-05, ORG-03A).** A `before insert or update` trigger on
`event_registrations` takes `select 1 from events where id = ... for update`
before counting. That row lock serialises every registration attempt for one
event, so two people cannot both take the last place.
`ponytail: one lock per event row; registrations for a single event serialise. Fine at this scale — partition the count if one event ever sells thousands.`

### RLS

- `events`: a policy for `anon, authenticated` reading
  `status in ('published','cancelled') or hosts_event(id) or is_admin()
   or has_event_booking(id)`.
  Drafts stay host-only (ORG-02). `grant select on events to anon`.
  **The last clause is not optional** — without it, a host pulling a published
  event back to draft makes it unreadable to every attendee holding a ticket
  for it, and their booking renders attached to nothing. QLT-08 forbids
  exactly that. It lives in `event_visible()` so `ticket_types`, `event_public`
  and `event_availability` inherit it, and it consults **orders as well as
  registrations**, because `event_orders.registration_id` is
  `on delete set null` and a paid order can outlive its registration.
  No status filter: a cancelled registration with a refund still in flight is
  precisely the case QLT-08 names.
  *(Corrected 16 Sep — the original printed the narrow version, which shipped
  the bug. Do not narrow it back.)*
- `ticket_types`: same visibility as its event.
- `event_registrations` / `event_orders` / `event_refunds` / `event_tickets`: own rows, plus `hosts_event()`, plus `is_admin()`.
- `event_attendance`: **select** is own row, **or** `hosts_event(event_id)`, **or**
  `is_admin()`. Write stays host/admin only.
  *(Corrected 16 Sep. The contract originally said own-row-only select, which
  makes the check-in screen impossible: ATT-02 requires "already checked in"
  to name when and by whom — another person's row — and the arrivals count and
  roster read the whole event.)*
- **Feedback is admin-only on select. No exceptions** (FDB-09/11/12/13). An author's own progress comes from the `my_feedback_progress` view, which returns subject ids and outcomes and **never answer text**.
- Views for anon: `event_public` (every `events` column plus `host_names text[]`,
  no email addresses) and `event_availability`. `security_invoker = off`, gate
  in the `WHERE`, exactly as `member_directory` does it.

  `event_availability` is `event_id, slug, capacity, confirmed, remaining, state`.
  **`state` is `text`, not an enum** — cast it in TypeScript. `remaining` is
  null when `capacity` is null (unlimited), and `confirmed` counts live
  checkout holds as well as confirmed places, which is what stops the last
  ticket being offered twice while somebody is paying for it.

- **`created_at` exists on `event_registrations`, `event_orders` and
  `event_refunds`** and is load-bearing, not decorative: it is how a screen
  picks the current refund, the settled order and the most recent
  registration. Do not rely on the order rows come back in — PostgREST does
  not promise one, and `event_orders[0]` reporting "payment not completed" for
  a paid booking, because an abandoned order for a different ticket type
  happened to sort first, is a bug this already caused once.

- **`event_refunds` has no `currency` column.** Refund amounts format against
  `order.currency`. Assuming otherwise has already cost one compile error.

---

## 4. Routes

| Path | Who | Owner |
| --- | --- | --- |
| `/e/:slug` | public, no account | attendee |
| `/events` | public browse | attendee |
| `/events/checkout/:slug` | session | attendee |
| `/events/mine` | session | attendee |
| `/events/tickets/:id` | session, own | attendee |
| `/events/feedback/:slug` | attended only | feedback |
| `/manage/events` | host | organizer |
| `/manage/events/new` | may_create_events | organizer |
| `/manage/events/:id` | host | organizer |
| `/manage/events/:id/guests` | host | organizer |
| `/manage/events/:id/emails` | host | organizer |
| `/manage/events/:id/checkin` | host/staff | check-in |
| `/manage/events/:id/results` | host | organizer |
| `/admin/events/:id` | admin | admin |
| `/signup?event=:slug` | public | admin/auth |

`src/App.tsx`, `src/lib/types.ts`, `src/lib/features.ts` and
`src/components/ui.tsx` are **owned by the primary agent**. Need a route, a
type or a shared component? Ask — do not edit them.

---

## 5. Feedback questions — exact wording (FDB-02, FDB-08)

Seeded as `feedback_questions` version 1. Copy character for character.

**Peer, scope `peer`:**
1. slot 1, `text` — `What was the best quality you noticed in this person?`
2. slot 2, `choice` — `Would you like to meet this person again?` → `Yes` / `Maybe` / `No`
3. slot 3, `text` — `What would you most like to work on or collaborate on with this person?`

**Event, scope `event`:**
1. slot 1, `scale` — `How was the event?` → 1–10 slider, selected number shown (QLT-04)
2. slot 2, `text` — `What did you enjoy the most?`

---

## 6. Email engine (EML-01 … EML-11)

`event_messages` + `event_message_recipients` are a queue, not a log written
after the fact. Everything is scheduled into them; one dispatcher sends.

- **Dispatcher**: `supabase/functions/event-mailer`. Claims due rows
  (`scheduled_for <= now()`, `status='scheduled'`), re-checks eligibility at
  send time (EML-07 — an outdated recipient list must not keep emailing
  cancelled attendees), sends via Resend batch, writes per-recipient status.
- **Trigger**: `pg_cron` every minute via `pg_net` if the extension is
  available; otherwise a GitHub Actions schedule hitting the function. Ship
  both, document which is live.
- **Reschedule (EML-06)**: moving `starts_at` moves unsent reminders. A
  reminder that lands in the past is marked `skipped`, never sent late.
  Moving `ends_at` moves the unsent `feedback_open` message.
- **Never** put submitted feedback in an email (FDB-03, EML-09).
- Recipients never see each other (EML-05) — one Resend message per person.
- Saving an event and notifying attendees are separate outcomes with separate
  labels (ORG-10, EML-03/08).

---

## 7. Payments (BUY-03, BUY-04, BUY-13, BUY-14)

Stripe Checkout, hosted. No card data touches us.

### 7.0 Who gets the money — the rule everything else serves

> **Whoever created the event owns its money.** An admin-created event pays
> Amazing. A super-connector-created event pays that connector, on their own
> Stripe. Being added as a cohost never moves the money.

Resolved from `events.host_id` — the creator — never from whoever happens to
be editing. An admin cohosting a connector's event changes nothing; a
connector cohosting an admin's event changes nothing (ORG-05: "being a cohost
does not create an automatic revenue split").

**One deliberate override.** An admin may explicitly name a different payment
recipient when creating an event, for the case where Amazing sets one up on a
partner's behalf. It is never the default, and it is shown unmissably before
sales open (BUY-14: "make the responsible payment account clear before sales
open").

### 7.1 Stripe Connect, Standard accounts, direct charges

A super connector connects **their own** Stripe account by OAuth. We store
`connectors.stripe_account_id` (`acct_…`) and nothing else. **We never hold
anybody's secret key**, and no connector ever configures a webhook of their
own — connected-account events arrive at our one endpoint tagged with
`event.account`.

Charges are **direct charges**: created on the connected account by sending
`stripeAccount: acct_…` as a request option with our platform key. That is
what makes BUY-14 literally true — funds land in their balance, **they pay
Stripe's fees**, they own disputes, and refunds come out of their money. A
destination charge would leave fees and disputes with Amazing, which is the
opposite of what the requirement says.

`application_fee_amount` is **not set** in this release: §13 excludes platform
commission. `event_orders.application_fee_cents` exists and is always 0.
`ponytail: direct charges mean adding commission later is one parameter, not a re-architecture.`

### 7.2 Two things are frozen, permanently

A connector can lose their hosting permission, disconnect Stripe, or be
restricted by Stripe, long after tickets were sold. Refunds must still work.

- **`event_orders.stripe_account_id`** — which account actually took *this*
  payment, written at checkout. Every refund goes back through it. Never
  recomputed from the event, because the event's answer can change.
- **`events.payment_locked_at`** — set when the first paid order exists. After
  that the event's payment recipient is immutable. Revenue for tickets already
  sold cannot be retargeted.

### 7.3 Gates before paid sales open

| Connector state | Free events | Paid events |
| --- | --- | --- |
| hosting permission off | cannot create | cannot create |
| permission on, no Stripe connected | yes | **blocked** — refuse publish, offer *Connect Stripe* |
| connected, `charges_enabled` false | yes | **blocked** — say what Stripe still wants |
| connected and ready | yes | yes |
| was ready, now disconnected/restricted | yes | **new** sales stop; existing bookings, tickets, check-in and refunds keep working |

The last row is the one that is easy to get wrong. Losing payment capability
must never strand people who already bought a ticket (BUY-14: "Preserve access
to existing bookings and payment support").

- `supabase/functions/stripe-checkout` — creates a `pending` registration
  (holding a place, `hold_expires_at = now() + 20 min`) and a Checkout
  session. Returns the URL.
- `supabase/functions/stripe-webhook` — the **only** thing that confirms an
  order. `checkout.session.completed` → order `paid`, registration
  `confirmed`, ticket issued, confirmation message queued. Signature verified
  with `STRIPE_WEBHOOK_SECRET`. Idempotent on `stripe_checkout_session_id`.
- `supabase/functions/event-refund` — authorised refunds, writes
  `event_refunds`, queues the refund-status message.
- BUY-13: platform events use Amazing's own account. BUY-14: a connector
  event uses `connectors.stripe_account_id` via `stripe_account` on the
  request. Incomplete setup blocks new paid sales and says how to fix it —
  existing bookings stay supportable.
- **Secrets are not available yet.** Read `STRIPE_SECRET_KEY` /
  `STRIPE_WEBHOOK_SECRET` from the environment and fail clearly when absent.
  Free events must work with no Stripe configuration at all.

---

## 8. Reporting to the primary agent

Finish with:
1. Files created/changed.
2. Requirement tags covered, and any you could not.
3. Anything you needed from another workstream that was not in this contract.
4. The command that proves your part works.

Do not edit another workstream's files. Blocked on someone else? Report it
and build against the contract as written.
