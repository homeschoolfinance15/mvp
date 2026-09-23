# Data protection — what happens when somebody asks to be forgotten

Amazing, 16 September 2026. Written for a lawyer; no code needs to be read.

There is **one open question** for you, at the end. Everything before it is
settled and implemented, and is here so the open question has its context.

---

## The short version

Three kinds of person can ask Amazing to erase them, and they get three
different answers. That is deliberate, and each answer rests on a different
legal footing.

| Who | What we keep | Why |
| --- | --- | --- |
| **A member or attendee who has paid for something** | The order — amount, currency, date, Stripe reference. The person is replaced by a pseudonym. | GDPR Art. 17(3)(b) and Companies Act 2006 s.388 |
| **Anybody erased, in the audit trail** | The record that an event happened. Their name, email and other details are overwritten. | Art. 17 applies; the event is not personal data |
| **A waitlist applicant or unclaimed invitee** | Nothing at all | No exemption applies to them |

Nothing is kept indefinitely. Retained financial records are destroyed
automatically seven years after the erasure, by a scheduled job.

---

## 1. People who paid: redact, retain, expire

**What we do.** When a paying attendee closes their account, we delete them.
Their profile, their registrations and their tickets go. Their **orders and
their attendance records survive**, with the person replaced by a stable
pseudonym such as *Former attendee 8F2A*. Seven years later a scheduled job
destroys those too.

**Why we keep the order.** Art. 17(3)(b) disapplies the right to erasure where
processing is necessary for compliance with a legal obligation, and s.388
requires accounting records to be kept for six years. We use seven to cover
the financial-year boundary, which is the usual convention. We are
implementing an exemption that exists, not balancing a right against a
convenience.

**Why a pseudonym rather than simply blanking the field.** Two reasons.

Art. 17(3)(e) preserves the right to retain data for the establishment,
exercise or defence of legal claims. A blank field makes it impossible to
answer *"were these three disputed refunds the same person?"* — the exact
question a chargeback defence turns on. A pseudonym answers it without
identifying anybody.

And practically: an organiser's revenue figure must not silently drop because
an attendee closed their account months later. The money moved regardless of
who has since left.

**Why this is pseudonymisation and not retained personal data.** The
identifier is an opaque reference to a record that no longer exists. There is
no key anywhere that turns it back into a person — the profile, the login and
the email are all gone. That is Art. 4(5).

**What comparable platforms do.** Stripe does not permit deleting a charge at
all. Shopify has a redaction operation distinct from deletion and keeps order
financials. Eventbrite removes the profile and retains the order with the
attendee anonymised. Airbnb and Uber retain trip and payment records with the
user pseudonymised. We are not doing anything unusual.

---

## 2. The audit trail: the event survives, the person does not

Amazing keeps an append-only log of what happened — who changed what, and
when. It is readable only by an administrator.

**The problem we found and fixed.** That log recorded the whole of a record
when it changed, so a deletion entry contained the person's name, email and
LinkedIn URL in plain text, and would have held them for 548 days after the
person was erased. That defeated the erasure.

**What we do now.** On erasure, the identifying values in the log are
overwritten with the same pseudonym. The entry itself — *something was
deleted, at this time* — survives untouched.

**Why not delete the log entries.** Because that destroys the evidence along
with the name. The fact that a deletion occurred, and when, is not personal
data about the erased person; it is Amazing's record of having acted. Keeping
it is what lets us demonstrate compliance under Art. 5(2).

---

## 3. Waitlist applicants and unclaimed invitations: keep nothing

Somebody who joined a waitlist, or was invited and never accepted, has given
us an email address, a phone number, a name and sometimes a LinkedIn profile —
and has received nothing. No account, no ticket, no payment.

**They have no orders. So no exemption applies to them at all.** Art. 17
applies in full with nothing carved out.

We therefore keep nothing. Their record is deleted and their details are
overwritten in the audit trail. **We deliberately do not give them a
seven-year retention entry**, because writing one would assert a legal
obligation that does not exist, and would place a retention clock on data we
have no right to hold.

---

## 4. Retention is enforced, not merely stated

A retention policy that is written down and never executed is itself a
breach of Art. 5(1)(e) — storage limitation. Ours runs weekly and destroys:

- audit entries older than 548 days
- retained financial records whose seven years have expired

Nothing is eligible for destruction yet; the earliest is 2033. The job logs
what it destroyed each time it runs.

---

## 4a. Two ways to close an account

Since 23 September 2026 anybody closing an account — themselves, or an
administrator or connector closing it for them — chooses one of two answers.
The database decides what each removes; the screen only asks.

| | **Delete the account** | **Delete the account and everything in it** |
| --- | --- | --- |
| Profile, login, posts, comments, likes, circle messages, registrations, tickets, recommendations, questionnaire answers | Deleted | Deleted |
| Their own waitlist application (matched on their confirmed email) | Deleted | Deleted |
| Events they host that nobody else is part of | Deleted | Deleted |
| Their attendance records | Kept, pseudonymised (§1) | **Deleted** |
| Event feedback they wrote | Kept, pseudonymised | **Deleted** |
| Notes they wrote about other people (§5) | Kept, pseudonymised | **Deleted** |
| Notifications their actions sent to other people | Kept, sender removed | **Deleted** |
| Uploaded photos and video | Left in storage | **Deleted** (by whoever closes the account: themselves, their connector or an administrator; the database refuses while any are left) |
| **Orders and refunds** | **Kept, pseudonymised, seven years** | **Kept, pseudonymised, seven years** |
| Anything of another person's: tickets, registrations, orders, attendance, invitations (including ones this person sent them), co-hosting, posts and feedback | Never touched | Never touched |

**What is always kept, and why.** Payment records, for the reason in §1: Art.
17(3)(b) and Companies Act 2006 s.388. The dialog says so in those words:
*"Payment records are kept, without your name, for seven years because
accounting law requires it."* Eventbrite, Stripe and Airbnb make the same
split — the profile and content go, the transaction stays with the person
removed.

**What still refuses a closure, in both modes.** A refund in progress; hosting
an event anybody else is part of — registered, paid, attended, invited,
co-hosting, posted about it or left feedback — because deleting the host
deletes the event and those rows with it (reassign it first; there is no
screen for that yet); and a connector who still has members, or whose circle holds messages
other people wrote — deleting the connector would take those people's words
with it.

**One known edge.** The screen removes the uploaded files before it asks the
database, because afterwards nobody but an administrator may. If the database
then refuses for one of the reasons above, the files are already gone and the
account is still open. Only the second answer removes files, and it asked for
them to go either way.

**Typed confirmation.** The second answer cannot be undone and is wider than
people expect, so it asks for the word DELETE to be typed, as GitHub does
before deleting a repository.

---

## 5. The open question, and it is the only one

**Peer feedback is split by direction when somebody is erased.**

After an event, attendees may write short private notes about the people they
met — what they noticed, whether they would meet again, what they might work
on together. Only administrators can read them. The people written about
never see them.

When somebody is erased:

- notes written **about** them are **deleted**
- notes **they wrote about other people** are **kept**, with the author
  replaced by the pseudonym

**Why we keep what they wrote.** A note is also the *subject's* record.
Deleting it rewrites a third party's history to satisfy a request that was not
about them — and the whole purpose of keeping these is to tell a one-off
impression apart from a repeated pattern across several events. This is what
Airbnb and Trustpilot do with reviews by departing users.

**Why we are asking you.** Free text can identify its author by content or
style, and short written answers about a named person at a named event narrow
the field considerably. If a pseudonymised note is not genuinely anonymous,
keeping it may not satisfy the erasure request.

Mitigating it: the notes are visible only to Amazing administrators, never to
other members, never exported, never in an email. The author's identity is
removed, not merely hidden. Volumes are small.

**What we need from you:** is retaining a pseudonymised free-text note, written
by an erased person about a third party, defensible under Art. 17 — or should
it be deleted with the rest of them?

**Either answer is cheap.** Deleting them as well is a one-line change and no
data has been lost in the meantime.

**Partly answered since (§4a).** A person who chooses *delete the account and
everything in it* has asked for exactly this, so their notes go. The question
above now applies only to the default choice, *delete the account*.

---

## What is not at stake here

- **Card details.** We never see or store them. Payment is handled entirely by
  Stripe's hosted checkout.
- **Anybody's secret keys.** Event hosts who take their own payments connect
  their Stripe account by OAuth; we hold an account reference, never a
  credential.
- **Live members.** Everything above applies only to people who have asked to
  be erased. Nothing changes for anyone who has not.

---

## Record of the answer

> *Answered by:*
> *Date:*
> *Decision:*

Record it here and it stays next to the code it governs. The implementation
lives in migrations `20260916000011`, `22`, `29`, `30`, `31` and
`20260923000801` (the two ways to close an account); each carries its
reasoning in its own header.
