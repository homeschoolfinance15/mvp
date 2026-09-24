-- New events, their ticket options and orders default to US dollars. Only the
-- default changes: every existing row keeps the currency it was created with,
-- and an organiser can still pick GBP or EUR per event.

alter table public.events       alter column currency set default 'usd';
alter table public.ticket_types alter column currency set default 'usd';
alter table public.event_orders alter column currency set default 'usd';
