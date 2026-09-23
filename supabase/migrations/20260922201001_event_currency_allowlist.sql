-- ORG-20 (round 2). An event's currency is one the editor offers: gbp, eur or
-- usd (EventEditor.tsx currency select). The lifecycle trigger only checks the
-- shape, so 'xyz' was stored. ticket_types follow via guard_ticket_type(),
-- which requires the event's currency. NOT VALID: an old row is not re-judged
-- until it is next written, as with the trigger's other ORG-20 checks.

alter table public.events drop constraint if exists events_currency_allowed;
alter table public.events
  add constraint events_currency_allowed check (currency in ('gbp', 'eur', 'usd')) not valid;
