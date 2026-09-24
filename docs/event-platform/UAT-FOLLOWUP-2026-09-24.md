# Remaining-gap acceptance tests — 24 September 2026

**Verdict: local coverage improved substantially; full release acceptance remains open.** Two requirement violations are confirmed. Real Stripe, inbox delivery, deployed scheduling and physical-phone scanning are not certified.

This follows the original [acceptance audit](UAT-2026-09-24.md) against the user's [requirements](REQUIREMENTS.md). The repository changed during testing: the completed runs spanned changes through `8cd3613`, with existing uncommitted feedback repairs. At final review, HEAD had moved to `08aef8b` and additional door-sales UI changes were present; those later changes were not covered by the completed runs. This is a local working-tree assessment, not a frozen release-commit or production audit.

## Results

| Remaining area | What was tested | Result and limit |
| --- | --- | --- |
| Host permissions | Added only a named cohost; attempted event edit, communications read and feedback read using their ordinary token | **Fail, R1:** naming a cohost grants editing and communications without separate permissions. Submitted feedback remains inaccessible. |
| Administrator replacement | Created a second administrator, demoted the original administrator fixture using an operator database action, checked retained event/guest/feedback access and attempted edit | **Fail, R2:** records remain readable, but the replacement administrator cannot edit the event while its creator is no longer eligible to host. The former administrator loses feedback-reading access. |
| Network membership and onboarding | Event-only attendee joined a connector network through the real invitation redemption RPC | **Pass locally:** account ID, completed profession, profile answers, ticket ID/code and feedback authorship are retained. Membership does not grant review-reading access. |
| Paid history on network joining | Converted a guest with an application-created simulated paid order and refund | **Pass locally:** purchase, refund and ticket records were unchanged; same account and onboarding. This uses simulated Stripe payments. |
| Existing network waitlist | Anonymous submission, private reads denied, admin assignment, invitation redemption, questionnaire claim | **Pass locally:** original questionnaire retained and no event booking created. These are database/API checks, not a complete waitlist browser regression. |
| Legacy RSVP transition | Replayed the actual legacy backfill in a rolled-back local transaction with an old RSVP fixture | **Pass locally:** one registration and ticket, original RSVP timestamp retained, no invented order or attendance. This tests backfill semantics on the current schema, not every migration against a production copy. |
| Payment integration | Actual checkout, webhook, refund, Connect, reconciliation and email-queue handlers against local Supabase and simulated Stripe | **175/175 pass.** Includes platform/connector routing, currencies, final-place race, duplicate callbacks, pending/failed payment, refunds, lost-webhook recovery, restricted/disconnected account support, and fee ingestion. Real Stripe OAuth, test-card checkout, real fee/dispute behavior and production webhooks remain unverified. |
| Emails | Actual dispatcher against a local provider-capture adapter; injected provider failures; retries; late corrected attendee; cancellation before reminder; current event address | **Pass locally:** failure status, ticket retention, failed-only retry, no resend to prior successful recipients, private recipients, no review text in feedback requests, current details and cancellation recheck. No external message was sent or delivered. |
| Automatic scheduler | Read local cron configuration and checked the committed GitHub workflow | **Not demonstrated:** no local `event-mailer` or `stripe-reconcile` cron job was present. Workflow exists, but its deployed secrets/runs were not verified. Calling the dispatcher without a browser proves independence from the UI, not that a deployed timer runs. |
| Scanning and interrupted connections | Chromium check-in UI, unavailable camera-decoder path, aborted check-in request, reconnect/retry | **Pass for fallback/recovery:** clear unsupported-browser message, typed entry, no false success while disconnected, retry reports already checked in and preserves one arrival. Native decoder was unavailable in this browser. Actual camera decoding on Android/iPhone remains untested. |
| Load and concurrency | 100 simultaneous free-registration requests against a 100-place event with one existing place; 50 concurrent distinct-ticket check-ins; 20 scans of one ticket | **Pass after R3 correction:** 99 additional places issued, one sold-out rejection; all 50 distinct-ticket requests completed; duplicate scans produced one arrival. This is a local sample, not production throughput certification. |

## Confirmed open defects

### R1 — Named cohosts automatically receive event-management access

**ORG-05; confirmed through authenticated API calls.** Inserting a row into `event_hosts` was sufficient for that connector to edit the event venue and read its communications settings. There was no separate permission assignment. The host/team UI and schema do not provide a display-only host versus event-staff distinction.

Reproduction is in [uat-remaining.mjs](../../scripts/uat-remaining.mjs). Existing event isolation and admin-only feedback tests still pass. The required change is a distinction between the named hosting team and the accounts authorized to operate the event; merely documenting broad cohost access does not satisfy the brief.

### R2 — New administrator cannot edit an event after the original admin-host is demoted

**ORG-14, ORG-15; confirmed HTTP 403.** A replacement administrator can read the event, registrations and feedback. An ordinary event PATCH fails with `new row violates row-level security policy for table "events"` after the original creator's role changes from administrator to ordinary user. Restoring the creator's administrator role makes the edit work again.

The `events_update` policy in `20260909000001_event_cohosts.sql` requires `may_host_events(host_id)` even for a platform administrator. This incorrectly makes continued event editing depend on the original creator's hosting eligibility.

The test changes only its own fixture's role through the database's internal role-change guard. REST deliberately pins roles, so a successful REST PATCH alone was not treated as proof of demotion. No real administrator was modified.

## R3 — Check-in lock regression found and corrected locally

The broader distinct-attendee test exposed timeouts in the pending feedback repair. Attendance inserts hold a foreign-key `KEY SHARE` lock on the event, while `ensure_feedback_request` requested `FOR UPDATE` on that same row. Concurrent attendance transactions could block one another upgrading those locks.

Changed that scheduling lock to `FOR NO KEY UPDATE` in the still-unreleased [repair migration](../../supabase/migrations/20260925100301_uat_feedback_and_updates.sql). Scheduling remains serialized, while attendance foreign-key locks no longer conflict with the requested lock mode.

- Before: 33 of 50 distinct-ticket requests returned statement/connection-pool timeouts in the captured run; total approximately 17 seconds. See [before-correction evidence](uat-evidence/remaining-before-lock-fix.json).
- After, isolated run: 50/50 known successful/already-present outcomes in 322 ms; subsequent run 336 ms, with no failures. Free registration: 99 successful new registrations plus the existing place in 822 ms in the final run.
- The original duplicate-scan/rescheduling suite also passed **11/11**, including late attendance corrections and preservation of sent feedback requests.

These are measurements from local Docker/Postgres on this workstation. They are not a latency guarantee. The demonstrated test envelope is 100 attendee places, a burst of 100 free-registration requests and a burst of 50 check-in requests. Mixed paid/free load, sustained traffic, production infrastructure and real device/network conditions still require verification before choosing a production operating limit.

## Evidence and reproduction

The original D1–D5 repair cases now pass locally: submitted feedback stays out of non-admin readback/export, historical question wording is immutable, later updates have a current preview and recipient count, a blank subject uses the previewed default, and earlier rescheduling/late attendance retain initial feedback requests without duplicate sends. These repairs are not a production-deployment claim.

| Evidence | Result |
| --- | --- |
| [Browser/API suite](uat-evidence/independent-results.json), [script](../../scripts/uat-independent.mjs) | 45/45 passed |
| [Concurrency/rescheduling suite](uat-evidence/concurrency-results.json), [script](../../scripts/uat-concurrency.mjs) | 11/11 passed |
| [Remaining-gap suite](uat-evidence/remaining-results.json), [script](../../scripts/uat-remaining.mjs) | 20/22 passed; R1 and R2 fail |
| [Payment integration](uat-evidence/payment-integration-results.json), [runner](../../scripts/uat-payments.mjs) | 175/175 passed with simulated Stripe |
| [Paid continuity](uat-evidence/paid-continuity-results.json), [script](../../scripts/uat-paid-continuity.mjs) | 2/2 passed |
| [Scanner unsupported](uat-evidence/scanner-unsupported.png), [interrupted request](uat-evidence/scanner-interrupted.png) | Browser screenshots |
| Production frontend build | Passed; existing large-bundle warning |
| Lint on added/updated test scripts | Passed |

The scripts use local Supabase and cached local Deno/Chromium tools. `uat-payments.mjs` uses simulator port 12112 and handler gateway 5489, leaving an existing simulator on 12111 untouched; the returned simulated checkout URL retains the older harness convention. The mailer adapter on 5488 captures provider requests and rejects external networking. The API/email browser adapter uses 5487 and Vite uses 5187. No actual attendee email or payment was sent.

Payment fixtures and detailed simulator logs remain under the existing local `scripts/stripe-sim/out` convention for inspection. Run paid continuity after payment scenarios. The remaining-gap/browser/concurrency suites clean their owned fixtures; retained operational/audit records may remain under application retention behavior.

Early diagnostic runs encountered an occupied simulator port, missing internal function routing, and fixture/locator assumptions invalidated by concurrent changes to currency defaults and venue search. Those failures were corrected in the harness and the final evidence above supersedes them. One earlier browser run also left onboarding for the event page unexpectedly; three subsequent runs stayed on onboarding and completed signup. Keep that intermittent observation under regression coverage rather than marking it a confirmed fixed defect.

## What is still needed for full acceptance

1. A staging URL configured with **Stripe test mode**, test Connect accounts and webhook delivery. Exercise hosted checkout and real refunds; verify actual payment-account/fee records and payment support. Do not use live money for UAT.
2. An authorized test inbox and configured email provider. Verify actual message contents, links, delivery problems and failed-only retry. Watch an unattended deployed schedule send reminders/feedback with no dashboard open. Confirm the actual deployed scheduler/secrets rather than inferring them from a workflow file.
3. Physical Android and iPhone testing over HTTPS: camera permission, QR decoding, damaged/printed screens, repeat scanning, interrupted connectivity and recovery. A responsive browser viewport or typed code is insufficient proof of camera scanning.
4. Rehearse deployment/migrations against a copy of representative legacy data and test final production-like load targets, mixed payment/free competition and sustained operation on the intended infrastructure.
5. Resolve R1 and R2, rerun their failing cases, and rerun acceptance on a frozen release commit. Local feedback repairs and R3 have **not** been deployed by this test run.

Staging/test-inbox details were requested during the run and were not supplied before this report. This is the remaining external-test prerequisite, not evidence that those journeys pass.
