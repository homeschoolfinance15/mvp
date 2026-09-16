# Amazing Event Platform Developer Requirements

Developer handoff · 10 September 2026

> **This is the client's document, reproduced verbatim.** It is the source of
> truth for *what* to build. `CONTRACT.md` is our answer to *how*, and where
> the two disagree, this file wins and `CONTRACT.md` is wrong and must be
> corrected. Requirement tags (`ACC-01`, `BUY-05`, `EML-06`) are cited from
> here throughout the codebase.

## Purpose of this document

Build the event platform described below inside Amazing. This document defines the attendee, organizer, and administrator experiences; permissions; ticketing and payments; attendance; communications; feedback; and information the product must retain. It is the product brief for design, implementation, and acceptance. The development team owns the technical architecture, database design, services, payment integration, and implementation approach.

The initial operation is Amazing-run events, created by the administrator and paid through Amazing's Stripe account. Build the connector permission controls described below so the administrator can enable individual connectors to host their own events. A connector's event management and payment access must be ready before their paid events can go on sale.

## 1. Overall goal

Replace the basic event experience with a polished event platform inside Amazing. At launch, only the administrator creates, publishes, and hosts events. People can create an account to attend even if they do not belong to a connector's network. Support free RSVP, paid tickets, event management, scannable entry tickets, reminders, cancellations, and feedback after events.

The administrator has an on/off permission for each connector controlling new event creation and publication. All connector permissions start off. Once enabled, a connector can publish their own events directly without separate approval of each event. Turning that permission off preserves their ability to manage existing events and support their attendees.

People should be able to move through this complete experience:

Discover event → create account/sign in → complete required onboarding → register/pay → receive ticket → attend/check in → give feedback → revisit past events.

The existing signup profiles and network relationships must continue working. This document does not require replacing the rest of Amazing.

## 2. Accounts and access

**ACC-01 — Event-only account.** Someone can create an account without a connector invitation, complete Amazing's required signup/profile questions, log in again, browse available events, register/pay, view tickets, manage their attendance, and give eligible feedback.

**ACC-02 — No automatic network assignment.** Buying a ticket, attending an event, or being invited to an event does not place someone in the host's or any other connector's network. Event-only attendees have no connector assignment.

**ACC-03 — Existing members.** People already in Amazing use their existing account and completed profile to register. Do not ask them to repeat completed onboarding unnecessarily.

**ACC-04 — Hosting permissions.** At launch, only the administrator creates, publishes, and hosts events because connector hosting permissions start off. Ordinary account holders cannot create or publish events. Once the administrator enables a connector's permission, that connector may create and publish their own events directly, subject to completing required event details and payment setup. Hosting an event must not grant permission to manage another connector's network.

**ACC-05 — Private information.** An event-only account must not gain access to private connector circles, connector notes, other people's private profile answers, or private network information merely by signing up or buying a ticket.

**ACC-06 — Later network membership.** An event-only attendee who later joins a connector's network keeps the same account, completed profile, purchase history, tickets, and feedback. Adding membership must not create a duplicate person or detach their event history.

**ACC-07 — Signup continuity.** When someone starts signup from an event, return them to that event after signup and required onboarding. Preserve their selection, but explain if availability or price changed while they were signing up.

**Permission rule:** Event attendance and event-hosting permission are separate. Creating an account or joining a connector's network must never automatically grant the ability to create or publish events.

## 3. Event pages and discovery

**EVT-01 — Shareable page.** Each event has its own link that a host can send to anyone. Someone without an account can understand the event before being asked to register.

**EVT-02 — Event information.** Show the event title, cover image, description, host identity, start and end dates/times, time zone, venue/address, attendee instructions, ticket options, current availability, registration action, and cancellation/refund terms where relevant. Existing attendees must see current event details on their ticket and event page after an update.

**EVT-03 — Accurate status.** Clearly show when registration is open, sold out, closed, or the event is canceled or finished. Do not let someone buy entry to a canceled event.

**EVT-04 — Clear pricing.** Before payment, show ticket price, any added fees/taxes, total amount, and currency. Do not surprise the attendee with extra charges after confirmation.

**EVT-05 — Event browsing.** People can browse available upcoming events and open their event pages. Show the information needed to choose an event, including title, image, date/time, location, price or free entry, and current availability. Keep the event list and event page consistent.

**EVT-06 — Public event access.** Launch events accept registration from eligible Amazing account holders regardless of network membership. A visitor can open a shared event link without an invitation. Account creation and required onboarding happen before registration or payment.

**Launch access scope:** Community invitations are included. Private/network-only events, invitation-only registration, and approval of individual attendees are excluded.

## 4. Creating and managing events

**ORG-01 — Administrator event creation.** The administrator can create, edit, preview, publish, unpublish, and cancel an event. The experience must make required fields and errors clear. At launch, connector permissions are off and ordinary account holders cannot publish. An explicitly enabled connector follows ORG-01A and ORG-01B.

**ORG-01A — Connector event-creation permission.** In the administrator's connector-management view, each connector has a clearly labelled event-creation permission that the administrator can switch on or off. It starts off for every connector. Turning it on authorizes that connector to create drafts and publish their own events; it does not publish anything as a side effect. Turning it off blocks new event creation and does not delete records or silently cancel existing events. Existing event-management access is preserved as described in ORG-01C. Record who changed the permission and when.

**ORG-01B — Direct publication.** An enabled connector may publish their own event directly once required event information and, for paid events, payment setup are complete. No separate administrator approval is required for each event. A proposal queue, approval/rejection process, requested-changes workflow, and resubmission flow are not required. The administrator retains platform-wide event management.

**ORG-01C — Existing events after permission removal.** Disabling a connector's event-creation permission does not remove management access to events they already host. They can still edit event details, manage guests and invitations, operate check-in, send communications, handle cancellations/refunds, and view operational results. The administrator retains control of every event, and feedback remains admin-only. Preserve existing drafts and records. Check the current event-creation permission before the first publication of an unpublished draft; existing published events remain manageable when permission is off.

**ORG-02 — Drafts and preview.** The administrator and enabled connectors can save unfinished events, return later, preview the attendee page, and publish when ready. Show whether changes are saved. An event must not appear in attendee discovery or accept registrations while it is an unpublished draft. Publication follows ORG-01B and ORG-01C.

**ORG-03 — Ticket setup and capacity.** An authorized event creator can set up a free or paid event and set the maximum number of tickets/RSVP places they want to sell. The system counts confirmed registrations across all ticket types and must prevent more confirmed places from being issued than the event allows. This applies to free RSVP events as well as paid events. The organizer can see the limit, confirmed count, and remaining places in the event dashboard.

**ORG-03A — Sold-out behavior.** When the confirmed registration count reaches an event's capacity, immediately stop further registrations and purchases and show **Sold out** on the public event page and in any registration flow. Someone who enters checkout after the last ticket is taken must receive a clear sold-out message and cannot be charged. If an organizer deliberately stops sales before capacity is reached, show **Registration closed**, not Sold out. When an existing registration is canceled, its place becomes available again unless the organizer has separately closed registration; the payment refund may still be processing. The public count/status must stay accurate when free RSVPs, paid tickets, cancellations, and ticket categories are used together.

**ORG-04 — Ticket option information.** Each ticket option offered must have a clear name, price or free status, currency where relevant, and availability. Show the chosen option consistently at checkout, on the ticket, and in the guest list. Where more than one ticket option is offered, all options share the overall event-capacity limit; the same remaining place cannot be sold twice through different options.

**ORG-05 — Hosting team.** Support more than one named host on an event. Distinguish a person listed as a host from the actions their account may perform. Event editing, guest/contact access, invitation sending, ticket scanning, and payment/refund actions must follow assigned event permissions. Cohost access is limited to the relevant event and never grants administrator review access or access to another community. The team can choose the simplest staff-permission arrangement that enforces these boundaries.

**ORG-06 — Own-event access.** The administrator can manage every event. An approved connector-host can manage only the events they are responsible for. Being a connector, or being permitted to create events, does not grant access to any other event.

**ORG-07 — Guest list.** Authorized organizers can see who registered or bought a ticket, the ticket purchased, registration status, payment status, and check-in status. Provide search and useful filters.

**ORG-08 — Attendee contact.** Authorized organizers can access the contact information needed to operate their event. They must not receive private network notes or unrelated profile answers through the guest list.

**ORG-08A — Invite selected community members.** An authorized organizer can open their event's guest/invite area, search or browse people in the community they are authorized to manage, select one or more specific people, and send an event invitation. The administrator can invite from communities the administrator manages; a future connector-host can invite only people in their own community and only to events they manage. The organizer cannot invite people from another connector's community merely because they can create an event. An invitation must not add someone to an unrelated community or reveal the recipient list to other invitees.

**ORG-08B — Invitation outcome.** Each selected person receives an Amazing in-app notification and an email identifying the event and host and linking to the current event page. A logged-out recipient signs in or creates an account and completes any required onboarding before registering. For paid events, the invitation leads to checkout; for free events, it leads to RSVP. An invitation does not confirm attendance, reserve a ticket, or bypass capacity. Until registration succeeds, show the person as invited with no confirmed registration. The organizer can see who was invited, available send status, and who subsequently registered. Keep other invitees and their email addresses private.

**ORG-09 — Corrections and attendee support.** Authorized hosts and administrators can help attendees recover tickets, correct missed check-ins, and manage cancellations/refunds within their event permissions. Ticket access remains available in the attendee account if an email is lost. Attendance corrections must work after the event under ATT-06. Record important support actions and the person who performed them.

**ORG-10 — Changes after publication.** When an organizer changes published event details, including the address, date, or time, they can choose to send an update email to affected attendees through the event editor. Show the changed details, email preview, and intended audience before sending. Saving an event edit and notifying attendees must have clearly distinguishable outcomes; never imply an email was sent merely because the event was saved. Event-cancellation notices are automatic. Section 8 defines the settings, update-email flow, and delivery tracking. A price edit must not change what an existing buyer already paid.

**ORG-11 — Event cancellation.** The administrator can cancel any event. An authorized connector-host can cancel events they manage. Stop registrations and ticket sales, invalidate entry, notify affected attendees automatically, stop pending ordinary reminders and feedback requests, show the status of paid orders and refunds, and retain the event's operational history.

**ORG-12 — Past events.** Hosts can open past events and see who registered, who attended, ticket sales, and cancellations. For now, all submitted peer feedback and host reviews are visible only to administrators. Non-admin hosts do not receive a feedback-reading view.

**ORG-13 — Event results.** Show registrations, attendance, ticket sales, refunds, and cancellations as distinct figures. Where fees and net receipts are shown, identify them separately from gross sales and use actual payment records. Do not label total ticket sales as profit.

**ORG-14 — Complete administrator event view.** From the administrator dashboard, the administrator can open any event and see its full operational record in one place, including event details and status, host(s), registrations, attendees, ticket types, payments, fees, refunds, cancellations, tickets, check-ins, email settings and message history, peer feedback, and host feedback. Appropriate links or sections may be used; "in one place" means the administrator should not need to impersonate another account or search through unrelated screens.

**ORG-15 — Platform-owned records.** Event information is platform data, not data stored inside or owned by the administrator's personal account. The administrator account has platform-wide permission to view and manage it. Replacing or adding an administrator must not detach, duplicate, or erase event history.

**ORG-16 — Event email controls.** Each event has an Emails and reminders area where its authorized organizer can configure automatic reminders, preview emails, send event-detail updates, and review scheduled and sent messages and delivery problems. At launch this is available to the administrator; authorized connector-hosts receive these controls for their own events when connector hosting is enabled.

## 5. Registration, payment, cancellation, and tickets

**BUY-01 — Account required.** A visitor must create an account or sign in and finish required onboarding before completing event registration. This applies to free and paid events.

**BUY-02 — Free registration.** A free RSVP confirms an available place and provides clear confirmation and an entry ticket.

**BUY-03 — Paid registration.** Successful payment confirms the place and produces the ticket and payment confirmation. A failed or unfinished payment must not appear as a completed purchase.

**BUY-04 — Payment waiting state.** If payment confirmation takes time, show that it is processing. A browser refresh, retry, or slow connection must not create duplicate charges or duplicate tickets.

**BUY-05 — Capacity.** Two people attempting to buy the last ticket cannot both receive that final place. Explain clearly when a selected ticket becomes unavailable.

**BUY-06 — Unfinished checkout.** Any temporary place held during checkout must expire when checkout is abandoned. Show a time limit where relevant and clearly explain when the place is no longer available. The team chooses the checkout-hold duration and mechanism; they must prevent overselling and permanently blocked places.

**BUY-07 — My events.** Attendees can find upcoming, past, and canceled events; open their tickets; see payment/refund status; and cancel or request cancellation according to the event policy.

**BUY-08 — Cancellation and money.** Treat canceling a place and refunding money as distinct outcomes. Someone should be able to see "Your attendance is canceled; your refund is processing." Never say money was refunded if it has not been confirmed.

**BUY-09 — Refund tracking.** If a refund fails or needs organizer attention, the attendee sees an accurate status and admins can find and resolve the issue. A repeated refund action must not return the same money twice.

**BUY-10 — Valid ticket.** Each confirmed attendee receives a scannable entry ticket associated with their account and event. Show attendee name, event, ticket option, event time, and entry instructions. Use a barcode or QR code that the check-in portal can validate reliably.

**BUY-11 — Canceled entry.** A revoked or canceled ticket must no longer admit its holder. If a ticket is replaced, the old entry credential must stop working.

**BUY-12 — Ticket recovery.** A person who loses the email can log in and recover access to their current ticket.

**Individual registration:** Each person registers for themselves through their own account. Do not issue duplicate active places for the same person at the same event through repeat clicks or retries. Group purchases, plus-ones, ticket transfers, and event waitlists are excluded from launch.

**BUY-13 — Launch payment ownership.** At launch, Amazing/admin-hosted events use Amazing's own Stripe account. Amazing receives the ticket revenue and is responsible for the associated payment processing fees, refunds, disputes, and other event-payment obligations.

**BUY-14 — Connector event payments.** When a connector is enabled to host paid events, they connect their own Stripe account. That event's designated host receives its revenue and covers the associated fees, refunds, disputes, and event-payment costs. The integration must implement that arrangement and make the responsible payment account clear before sales open. Do not route revenue to another host's account. When multiple hosts are listed, identify one payment recipient; being a cohost does not create an automatic revenue split. If payment setup is incomplete or unable to accept payments, prevent new paid sales and show the organizer how to resolve the problem. Preserve access to existing bookings and payment support.

**BUY-15 — Event terms and payment administration.** Present the event's applicable cancellation/refund terms before purchase and retain the terms associated with each order. Support authorized cancellation and refund handling with accurate status updates. Keep initial administration suitable for Amazing-run events; a platform commission feature, automated refund-policy builder, and multi-host revenue splitting are not part of this release. The payment implementation must identify any platform obligations that remain under the selected integration.

## 6. Arrival and attendance

**ATT-01 — Check-in portal.** Authorized event staff can use a phone or other appropriate device to scan tickets and admit attendees.

**ATT-02 — Scan results.** Clearly distinguish successful check-in, already checked in, wrong event, invalid/canceled ticket, and a temporary service problem.

**ATT-03 — Duplicate scans.** Repeated scans, including from different staff devices, must not create multiple arrivals for the same person.

**ATT-04 — Manual check-in.** Authorized hosts and administrators can search for a guest and manually record attendance if a ticket cannot be scanned or arrival was missed. Record who made the correction, when, and why. Staff access must follow the event permissions in ORG-05.

**ATT-05 — Attendance record.** Keep who actually attended separately from who RSVP'd or paid. Buying a ticket is not proof of being present.

**ATT-06 — Missed check-in.** A host can open the guest list after the event, find someone they know attended, and mark that guest as attended even if the original check-in was missed. Administrators can do this for any event; non-admin hosts only for events they manage. Preserve that attendance was corrected afterward, who made the correction, when, and why; do not fabricate an original scan or arrival time. Update the guest list, attendance totals, and feedback eligibility consistently. A guest cannot mark themselves attended. A missing check-in alone should not be presented as a definite no-show if check-in was incomplete.

## 7. Feedback after events

### Peer feedback

**FDB-01 — Other people.** After an event, participants can give feedback about other people at that event. They cannot rate themselves. Two people who hosted together can give each other peer feedback when both were present.

**FDB-02 — Three peer questions.** For each eligible person being reviewed, use the following wording and answer formats.

| Slot | Question wording | Answer format |
| --- | --- | --- |
| Peer question 1 | What was the best quality you noticed in this person? | Written response |
| Peer question 2 | Would you like to meet this person again? | Yes / Maybe / No |
| Peer question 3 | What would you most like to work on or collaborate on with this person? | Written response |

The third question records future collaboration interest. Preserve the written answer as the respondent's interest; it is not proof of completed collaboration or of mutual interest. A response from the other person is a separate record.

**FDB-03 — Invitation to respond.** After the event, automatically email eligible participants with a link to the feedback experience at its configured opening time. Preserve the destination through login. The email must not contain submitted reviews.

**FDB-04 — Find people.** Show recognizable names and available profile photos for the event's eligible participants, excluding the viewer. Make it practical to find people in larger events.

**FDB-05 — People they did not meet.** Let attendees skip someone they did not interact with. Do not force them to invent answers about people they never spoke to. Retain the difference between skipping, leaving a question unanswered, and giving an unfavorable response.

**FDB-06 — Feedback eligibility.** Only participants with verified attendance can submit peer or event feedback. A peer being reviewed must also have verified attendance at that same event. Buying a ticket, receiving an invitation, or RSVPing alone is insufficient. A scanned check-in or authorized attendance correction verifies presence. Present hosts are included as participants even if they did not buy a ticket; their presence must be recorded. Exclude the current user from their own peer-review list. After a missed check-in is corrected, update attendance totals, the eligible peer list, and that person's ability to respond. Include them in the initial feedback email if it has not yet been sent. If feedback has already opened, make the feedback link available and send their initial request without duplicating an earlier send. A corrected guest must not remain blocked solely because the original check-in was missed.

**FDB-07 — Completing responses.** Make the feedback flow easy to use on a phone. Show which people have already been reviewed and which remain. Recoverable errors must not erase entered answers, and repeated submission must not create duplicate reviews. Distinguish unsent work from successful submission. After submission, show confirmation and completion status while enforcing the admin-only rules below.

### Host/event feedback

**FDB-08 — Two event questions.** Provide a separate event-feedback form using these two questions. Store the answers against the event. Both answers remain admin-only.

| Slot | Question wording | Response format |
| --- | --- | --- |
| Host/event question 1 | How was the event? | 1–10 slider; show the selected number |
| Host/event question 2 | What did you enjoy the most? | Written response |

**FDB-09 — Admin-only visibility.** For now, all submitted peer feedback and host reviews are visible only to administrators. Administrators can view every review across all events. Non-admin attendees, hosts, and connectors cannot read those reviews. This applies to event pages, past-event results, downloads, notifications, and AI-written summaries as well as the ordinary feedback screen. Non-admin users must not receive review excerpts, scores, or summaries that reveal submitted feedback.

**FDB-10 — Event feedback and hosts.** The two questions in FDB-08 concern the event experience. Record the event and its hosting team as context. A separate review form for each cohost is outside this release. Do not convert an overall event rating into a distinct rating of every individual host. Keep self-review prevention in place. Peer feedback between two hosts who both attended remains supported under FDB-01.

**FDB-11 — Administrator who is also a host.** Administrator access takes precedence over host confidentiality. If an administrator is also the host of an event, that administrator can still see every review, including host reviews about themselves. The interface should not imply that those reviews are hidden from an administrator-host.

### Reading past feedback

**FDB-12 — Peer visibility.** Only administrators can read submitted peer feedback. The person receiving the feedback cannot see it, and neither can a non-admin event host or connector. Participants can fill in their own answers and receive confirmation that they submitted successfully; that does not grant access to submitted reviews. Any later expansion of review access requires a new product decision.

**FDB-13 — Past-event feedback access.** Administrators can open any past event and read all peer and event feedback, including feedback about themselves when they hosted or attended. Non-admin hosts can revisit operational results but cannot read reviews. Eligible attendees can return to the feedback flow from their past events; they do not receive a page displaying submitted reviews about themselves or others.

**FDB-14 — Visibility explanation.** Before submitting either type of feedback, explain that only Amazing administrators can read the responses and that administrators can identify who submitted them. Do not promise anonymity. An administrator who also hosted or attended the event retains this access.

**FDB-15 — Feedback scheduling.** Initial feedback requests go out automatically after the event at the configured opening time. Keep operational timing values adjustable without changing the meaning of stored responses. Apply saved scheduling rules consistently, including after rescheduling or attendance corrections, and make the scheduled request visible in event communications. The interface must accurately show whether the person can currently respond. Exact timing values are implementation settings, not fixed deadlines prescribed by this specification.

**FDB-16 — Original meaning.** If questions change later, past answers must remain associated with the questions asked at that time. Do not relabel an old answer with a new question.

## 8. Emails and notifications

**EML-01 — Automatic event emails.** Registration/ticket confirmations, payment confirmations, scheduled event reminders, cancellation notices, refund updates, and the initial request for post-event feedback go out automatically when the relevant action or scheduled time occurs. Organizers must not need to send these individually or keep the event dashboard open. Existing signup emails continue to work. Organizer-triggered event-change emails are also required as described below.

| Situation | How the email is triggered | Recipient | Message must make clear |
| --- | --- | --- | --- |
| Free RSVP confirmed | Automatically after registration is confirmed | Attendee | Their place is confirmed; event details and ticket access. |
| Paid ticket confirmed | Automatically after payment is confirmed | Purchaser/attendee | Amount/currency, payment status, ticket access, event details. Payment and ticket confirmation may be combined into one clear email. |
| Upcoming event | Automatically according to that event's reminder settings | Currently confirmed attendee | Correct current time/location and ticket access. |
| Selected community member is invited | Automatically after an authorized organizer selects them and sends the invitation | Invited person | Event/host identity, invitation message if supplied, and a link to view, register, or buy a ticket while places remain. |
| Address or other event details change | Organizer chooses to notify attendees from the change flow | Currently registered affected attendees | What changed, the replacement details, and a link to the current event page. |
| Attendee cancels | Automatically when cancellation is recorded | Attendee | Cancellation status and separate refund status. |
| Refund update | Automatically when the refund status changes | Purchaser | Requested, processing, completed, or needs attention, matching the actual status. |
| Event canceled | Automatically when event cancellation is confirmed | Affected attendees and anyone with an unresolved booking/payment obligation | Event will not happen and what happens to their booking/money. |
| Feedback opens | Automatically at the configured feedback-opening time | Eligible participant | How to give feedback inside Amazing; submitted review content is never included. |

**EML-02 — Settings for each event.** Give authorized organizers an Emails and reminders area. They can enable or disable scheduled pre-event reminders, add/remove reminder times, change how long before the event each reminder goes out, and preview the reminder email. Show the event time zone, the resulting scheduled dates/times, whether reminders are enabled, and whether settings are saved. Use editable operational defaults and clearly show the saved schedule and any limits in the controls. Turning off reminders does not turn off registration, payment, cancellation, refund, or initial feedback-request emails. Show those automatic messages and their triggers so the organizer knows what attendees will receive.

**EML-03 — Notify attendees when details change.** When an organizer saves changes to a published event's address, venue, date, time, or attendee instructions, offer a clear notification choice. Provide an email preview with a subject, the changed details, an optional organizer-written explanation, and the intended recipient count. The organizer can save the changes and send the update, or save without sending at that moment. Label these outcomes clearly. Sending an update does not require copying attendees into an outside email application. A later action from the event dashboard lets the organizer send the latest update if they initially saved without notifying.

**EML-04 — Accurate change content.** For an address change, clearly label the new venue/address and distinguish it from the previous address where useful. For a date/time change, include the new date, time, and time zone. Include the event name and a link to current event details/tickets. The update must reflect successfully saved changes; do not announce a change that failed to save. Update the event page, ticket view, and future automatic emails to use the current details. If details change again before an update is sent, require a refreshed preview of the latest details rather than silently sending an outdated announcement. Use the location information currently displayed for the event.

**EML-05 — Correct recipients.** Event reminders and operational update emails go to the relevant currently registered attendees, including free and paid registrations. Exclude canceled registrations and failed/unfinished purchases from ordinary reminders and venue updates. Cancellation and refund notices still reach the people affected by those actions. New registrants receive current information in their confirmation; they do not need a backlog of earlier address-change emails. Recipients must not see each other's email addresses. An event organizer cannot use these controls to contact another event's attendees or an unrelated connector network.

**EML-05A — Community invitation notifications.** When the organizer sends invitations under ORG-08A, create both an email and an in-app notification for each selected person. The notification must lead to the current event page and reflect its current availability; it must not promise a ticket if the event is already sold out. Do not invite a person twice by accident through repeated clicks. An organizer can deliberately resend an invitation when needed, and the message history must label it as a resend. If an event becomes sold out after invitations were sent, the invitation link must show Sold out rather than allow an over-capacity registration.

**EML-06 — Scheduling stays correct.** If the event's start time changes, adjust unsent pre-event reminders to the new start time; if its end time changes, adjust unsent feedback invitations according to the configured feedback-opening rule. Editing or disabling a reminder updates or cancels its unsent schedule. Repeated saves, repeated clicks, or recoverable delivery retries must not create duplicate copies of the same intended message for a recipient. Someone registering after an earlier reminder time receives their confirmation and any remaining future reminders; do not send already-past reminders as a backlog. If a reschedule places a reminder in the past, show it as skipped instead of unexpectedly sending it; the organizer can use the event-update action to communicate the new schedule.

**EML-07 — Cancellation and unsent messages.** Canceling the event stops unsent ordinary reminders and feedback requests and automatically sends the cancellation notice. Someone canceling their registration stops receiving ordinary event reminders. Recheck whether a person should receive a message when it is about to go out, so an outdated recipient list does not keep emailing canceled attendees. Messages already sent cannot be recalled; show their actual history. A queued update that has become outdated must not be sent without correction.

**EML-08 — Message history and recovery.** Organizers can see scheduled messages and a history of event emails, including message type, content, intended audience, send time, and available status such as scheduled, queued, sent, failed, or canceled. Record who triggered an organizer-written update. Distinguish saving an event, queueing a message, and sending it. Do not call an email delivered or read unless that status is actually available. Make delivery problems visible and provide a way to retry failed recipients without resending to everyone who already received the message. An email failure must not erase a valid ticket or undo a saved event change. If details were saved without notification, show that attendees have not yet been notified of that change and provide the send-update action.

**EML-09 — Permissions and confidential information.** Only the administrator and people explicitly authorized to manage that event's communications may change settings or send updates. Administrators can inspect settings and email history for every event. Other organizers can inspect only their own authorized events. Emails, previews, and communication history available to non-admins must not expose submitted peer feedback, host reviews, private connector notes, or unrelated private profile answers.

**EML-10 — Email presentation.** Emails should look like Amazing, read well on a phone, and contain usable links. Identify the event and host clearly. Organizers can preview scheduled reminders and event-change emails before sending or enabling them. Structured event facts such as the current address, time, and ticket link must remain accurate even when the organizer adds their own explanatory message. Developers should demonstrate the organizer experience as well as the attendee email.

**EML-11 — Initial timing settings.** The development team supplies sensible initial timing values for Amazing-run events. Pre-event reminders remain editable through the organizer controls, and feedback requests follow the saved operational schedule. Show when messages are due so the organizer can understand what will happen. Do not require the organizer to manually send each reminder or initial feedback request.

## 9. Information Amazing must remember — in plain language

Retain the following information and relationships. The development team chooses the database structure and technical implementation.

| Information | What must be remembered | Why |
| --- | --- | --- |
| Person | Their account identity, profile, and completed onboarding | Recognize the same person across all events. |
| Network membership | Which network they belong to, if any; relevant membership history | Separate event attendance from network access. |
| Event | Event details, organizer/hosts, and important changes | Revisit what happened and notify attendees accurately. |
| Hosting permission | Which connectors may create and publish events; who changed that permission and when; retained management access for existing events | Enforce administrator control independently of network membership, without a separate per-event approval step. |
| Payment recipient | Which host and payment account receive each event's revenue; associated charges, fees, and refunds | Keep each event's money attached to the correct host even if permissions change later. |
| Capacity and availability | Maximum sellable places, confirmed registrations, ticket-category quantities, registration-closed state, and when places open again | Stop overselling and accurately show available, sold out, or closed status everywhere. |
| Registration | Who reserved which place and whether it was canceled | Operate the guest list. |
| Community invitation | Event, inviter, each selected recipient, which community made them eligible, message/send status, and whether they later registered | Let organizers invite selected community members while preserving permissions and tracking the outcome. |
| Purchase | Who paid, for which ticket/event, amount/currency, and terms at purchase | Answer payment/refund questions accurately. |
| Refund | Which payment, amount, status, and when it happened | Track money independently of attendance. |
| Ticket | Who may enter which event and whether their ticket remains valid | Operate entry reliably. |
| Attendance | Who actually arrived and how attendance was confirmed/corrected | Know who participated in the event. |
| Peer feedback | Who wrote it, whom it concerns, the event, exact question/version, answer, and time | Understand specific interactions over time. |
| Host/event feedback | Who wrote it, which event it concerns and its hosts, exact questions, 1–10 answer, written answer, submission time, and confidential visibility | Give admins event-experience feedback without treating an event rating as an individual host rating. |
| Email settings and schedules | Each event's saved reminder settings, event time zone, upcoming send times, and changes to the schedule | Send automatic messages at the intended times and update them when the event changes. |
| Notifications | What was sent to whom, the event details announced, who triggered it, send time/status, and whether delivery needs attention | Support attendees, distinguish saved edits from announced changes, and avoid conflicting or duplicate messages. |

**Example:** John buys a ticket to a founders' dinner, attends, and gives feedback about Sarah. Amazing must preserve that this is John's opinion of Sarah after that particular dinner. It must not automatically become Sarah's opinion of John or a permanent general score for Sarah.

If John and Sarah meet again at a different event, retain a separate observation for that later meeting. This lets Amazing eventually distinguish a one-off experience from a repeated pattern.

**Information-quality requirements:** Keep actual answers; keep the associated questions; distinguish unanswered, skipped, did not interact, and unfavorable responses; preserve feedback when a person later joins or changes networks; keep payment and attendance history understandable when event details change.

**Administrator view versus information storage.** Amazing keeps the connected records centrally. The administrator dashboard is a way to see and manage those records; it is not where the information originates or a personal account that owns everybody's history. Information is saved as people register, pay, check in, and submit feedback, without waiting for an administrator to open an event. Adding or replacing an administrator must preserve those records.

**Future AI requirement:** Future analysis and AI should be able to read the permitted records from Amazing's shared system without relying on somebody logging into the administrator account, manually exporting its dashboard, or copying what appears on screen. Developers choose how to provide that controlled access. If AI produces a summary or recommendation, preserve the underlying answers so authorized people can investigate why. AI outputs must respect the intended audience's privacy rules, especially confidential host reviews; giving AI broad access must not expose those reviews to a non-admin host. A future AI result is not a replacement for the original feedback.

**Account changes and removal:** Closing or changing an account must not expose confidential information, detach event history from the correct person, or make outstanding bookings, payments, and refunds unmanageable. The team must handle access removal and retained operational records consistently with the product's account-management behavior.

## 10. Quality and continuity requirements

**QLT-01 — Polished design.** Event pages, signup, purchase, tickets, host management, check-in, and feedback must feel like one coherent Amazing product and work well on phones and computers.

**QLT-02 — Complete states.** Design loading, empty, error, sold-out, canceled, permission-denied, and session-expired experiences as well as the happy path. Explain problems in ordinary language and offer a sensible next step.

**QLT-03 — No lost work.** Recoverable problems should not unnecessarily erase signup, event-editing, or feedback input. Show a clear saved/submitted state.

**QLT-04 — Accessibility.** Essential actions must have usable labels, work with keyboard navigation, and use readable text. Explain status in words as well as color. The 1–10 slider must show the selected value and support accessible interaction.

**QLT-05 — Privacy.** Access restrictions apply everywhere information can appear, including downloads and summaries. Users cannot gain another person's access by changing a link.

**QLT-06 — Preserve existing users.** Rebuilding events must not break existing login, profile answers, connector relationships, or network permissions.

**QLT-07 — Preserve existing records honestly.** Review any existing events/RSVPs before transition. A legacy RSVP cannot be assumed to prove payment or attendance.

**QLT-08 — History.** Removing an event from ordinary browsing or closing a host account must not silently erase customers' outstanding bookings, purchases, or refund information.

**QLT-09 — Operational recovery.** Admins must be able to find and resolve failed payment confirmations, missing tickets, failed refunds, and failed messages. A purchase should not become untraceable because one step failed.

**QLT-10 — Performance and operating conditions.** Define and verify realistic event-capacity, ticket-sale, and concurrent check-in targets in the implementation plan. Handle slow or interrupted connections clearly, especially during payment and scanning. A temporary problem must not become a false payment success, duplicate charge, or duplicate check-in.

## 11. How we will review the finished behavior

These are product acceptance examples. Developers decide how best to verify them.

| Example | Expected result |
| --- | --- |
| New visitor comes from an event link | Can create account, finish onboarding, return, register, and find their ticket without joining a network. |
| Existing member registers | Uses their current account and completed profile. |
| Event-only account tries to open private network information | Cannot access it. |
| Ordinary account holder tries to create or publish an event | Cannot do so. Event attendance does not grant hosting permission. |
| Connector with event-creation permission switched off tries to create a new event | Cannot create a new event. |
| Connector's event-creation permission is switched on | Connector can create and publish their own event once details and payment setup are complete; no separate administrator approval is required. |
| Connector's permission is switched off again | New event creation is blocked; they retain management of existing events, including guests, check-in, communications, and refunds. Event, ticket, payment, and feedback records remain intact. |
| Administrator opens any event | Can see its complete operational record and every peer and host review. |
| Administrator opens reviews of an event they hosted | Can read those reviews because administrator access takes precedence. |
| Administrator account is replaced or another administrator is added | Existing event and interaction history remains available under the appropriate permissions. |
| Connector-hosted paid sales are activated later | Revenue goes to the event's designated host account, and the demonstrated fee/refund behavior matches the event payment setup. |
| Two people buy the last available ticket simultaneously | Only one receives that last place. |
| Buyer refreshes after paying | Their purchase remains single and their ticket is recoverable. |
| Payment remains unresolved | Person sees a waiting/help state, not a false success. |
| Attendee cancels a paid ticket | Entry and refund states are separately understandable. |
| Two staff members scan the same ticket | One arrival is recorded; subsequent scan reports already checked in. |
| Person scans a canceled ticket or one for another event | Entry is rejected clearly. |
| Organizer configures event reminders and closes the dashboard | Emails go out automatically at the configured times to eligible attendees. |
| Organizer disables or edits a future reminder | The unsent schedule reflects the saved setting; no duplicate or obsolete reminder is sent. |
| Organizer changes the address and selects save and notify | Saved event/ticket details update; the organizer can preview and send an email clearly identifying the new address to current attendees. |
| Organizer saves an address change without sending | Current event/ticket details update; the dashboard shows the change is not yet announced and offers a later send-update action. |
| Event is rescheduled | Unsent reminders follow the new event time; upcoming emails use current details and already-past reminder times are not sent as a backlog. |
| Organizer selects three named people from their authorized community and sends invitations | Each receives an email and an in-app Amazing notification linking to that event; the organizer can see invitation and later-registration status. |
| Connector-host tries to invite a person in a different connector's community | Cannot select or invite that person. |
| An invitee uses the invitation link | Can sign in/create an account, complete onboarding where needed, and register or buy a ticket if capacity remains. |
| Limited event reaches 30 confirmed registrations out of 30 | Further registration/purchase is blocked everywhere and the event shows Sold out. |
| Two people try to claim the final available place | Only one receives it; the other sees Sold out and is not charged. |
| A confirmed attendee cancels while registration remains open | Their ticket stops working; their place becomes available, while any refund status remains separately clear. |
| Organizer closes registration with tickets left | Event shows Registration closed rather than Sold out. |
| Person registers after one of the configured reminder times | Receives a confirmation with current details and remaining future reminders, without retroactive reminders. |
| Attendee cancels or the event is canceled | Relevant unsent reminders stop; the appropriate cancellation email goes out automatically. |
| Organizer retries an update after some emails fail | Failed recipients can be retried without duplicating the message for successful recipients; status remains accurate. |
| Non-admin organizer opens communications for another event | Cannot access its settings, recipients, or email history. |
| Email fails | The ticket still exists in the account; the issue is recoverable. |
| Person who only bought a ticket tries to submit feedback | Cannot submit until attendance is verified; purchase alone does not establish eligibility. |
| Host corrects a missed check-in after the event | Guest is marked attended, the correction is recorded, attendance counts and feedback eligibility update, and the initial feedback email follows FDB-06 without duplicate sends. |
| Attendee tries to mark themselves attended | Cannot self-check-in through the correction flow. |
| Participant tries to review a peer without verified attendance | That person is not an eligible peer-review target. |
| Participant tries to rate themselves | Cannot submit it. |
| Eligible attendee opens host/event feedback | Sees "How was the event?" with a 1–10 slider and "What did you enjoy the most?" with a written-answer field. Submitted answers are admin-only. |
| Two present hosts give peer feedback about each other | They can do so when both have verified attendance at the same event. |
| Non-admin host opens past-event results | Sees operational results; cannot read peer feedback, host reviews, or summaries revealing those responses. |
| Attendee or connector tries to read reviews about themselves or another person | Cannot read submitted peer feedback or host reviews, including through exports, notifications, or summaries. |
| Participant opens peer feedback | The first and third questions use written answers; the meet-again question offers Yes / Maybe / No. |
| Participant answers the third peer question | Is asked what they would most like to work on or collaborate on with that person; the answer is retained as future interest, not completed collaboration. |
| Feedback questions change next month | Previous answers keep their original questions and meaning. |
| Event attendee later joins a network | Their event and feedback history remains attached to the same person. |

## 12. Delivery and completion

Deliver a working event experience integrated into the existing Amazing application, covering the full attendee and organizer journeys described above.

The implementation must include:

- Event-only signup and onboarding that preserve the separation between accounts and private network membership.
- Public event pages and event browsing, event creation/editing, previews, publication, capacity controls, and cancellation.
- Administrator controls for connector hosting permission and continued management of existing events when that permission is disabled.
- Free registration, paid checkout, tickets, payment/refund status, and attendee access to upcoming and past events.
- Organizer guest management, selected community invitations by email and in-app notification, check-in, and post-event attendance corrections.
- Automatic transactional emails and event reminders, organizer reminder settings, preview/send controls for changed event details, and message history with failed-send recovery.
- The exact three peer questions and two event questions, attendance-based eligibility, and administrator-only access to submitted feedback.
- Complete administrator access to each event's operational records and reviews, with the information retained for future permitted analysis.
- Responsive interfaces and clear empty, loading, error, unavailable, canceled, and permission-denied states.

Use the acceptance examples in section 11 to demonstrate completion. Include working attendee emails and organizer controls in that demonstration. A working event-creation form alone is not completion of this feature.

The development team is responsible for selecting the architecture, services, database, payment approach, staff-permission implementation, and operational timing defaults that deliver these behaviors. Preserve existing login, onboarding, profiles, connector relationships, and data during the transition. Provide a clear implementation plan and operating instructions for the administrator.

## 13. Release boundaries

This release does not include group tickets, plus-ones, ticket transfers, event waitlists, restricted or invitation-only events, approval of individual attendees, or a separate administrator approval process for each event. Normal community invitations do not reserve a private allocation of tickets. The existing network-signup waitlist remains separate and must keep working.

Additional features such as promotional codes, event duplication, guest-list exports, calendar integrations, online-event tooling, marketing campaigns, SMS/WhatsApp messaging, a full email-template editor, offline check-in, platform commission management, or per-cohost review forms are outside the required build described here. Preserve the data needed for future matching and analysis; building the AI matching system itself is not part of this event release.

Feel free to reference other products such as Luma for a good, easy-to-use interface.

---

## Addendum — payment routing, settled 16 September 2026

Clarified by the client after the handoff, and binding:

> A **super connector** — the client's name for a connector whose
> event-creation permission is switched on — can create and host events, and
> brings their own Stripe account, as on Luma.
>
> **Whoever created the event owns its money.** An admin-created event pays
> Amazing. A super-connector-created event pays that connector, on their own
> Stripe. Being added as a cohost never moves the money.

Implementation decisions taken from this, recorded in `CONTRACT.md` §7:

- **Stripe Connect OAuth, Standard accounts.** We store only an account id.
  We never hold anyone's secret key. Chosen over pasted API keys because a
  pasted key would also require every connector to hand-configure a webhook
  endpoint in their own Stripe dashboard before their first sale, and payment
  confirmation depends on that webhook (BUY-03, BUY-04).
- **Direct charges.** Funds land in the host's balance, the host pays Stripe's
  fees, and the host owns refunds and disputes — which is what BUY-14 says.
- **An admin may explicitly name a different payment recipient** at creation,
  never by default, shown unmissably before sales open (BUY-14).
- **The recipient freezes** once a paid order exists, and every refund routes
  through the account that actually took that payment, so refunds survive a
  connector losing permission or disconnecting Stripe.
