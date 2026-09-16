-- ---------------------------------------------------------------------------
-- 20260916000033_ticket_type_availability
--
-- ORG-03A, ORG-04. "The public count must stay accurate when ticket
-- categories are used."
--
-- It did not. `ticket_types.quantity` is the cap an organiser sets, and
-- `ticket_types_quantity_sane` (000004:54) constrains it to `null or > 0`, so
-- it can never reach zero — and nothing has ever written to it after
-- creation. The public page rendered it directly as "N left", which meant a
-- twenty-place option read "20 left" when nineteen had gone, and read "20
-- left" again when the twentieth sold.
--
-- What was NOT wrong, and must not be "fixed" again by somebody reading this
-- later: the cap itself is enforced, in enforce_event_capacity
-- (000021:133-147), which counts confirmed and live-pending registrations for
-- the ticket type under the event row lock and raises 'That ticket option is
-- sold out.' Nobody was ever sold the twenty-first place and no money moved
-- that should not have. The defect was entirely in what the page said, and
-- its consequence was that the last buyer learned the option had gone by
-- being refused at the end rather than by seeing it before they started.
--
-- So this adds no enforcement. It exposes the number the trigger already
-- computes, so the screen can say the same thing the database will.
--
-- The count matches the trigger's predicate exactly — confirmed, plus pending
-- whose hold has not lapsed. Any other definition here would put the screen
-- and the trigger into disagreement, which is the bug this is fixing, one
-- layer along.
-- ---------------------------------------------------------------------------

create view public.ticket_type_availability
with (security_invoker = off) as
select
  t.id            as ticket_type_id,
  t.event_id,
  t.quantity      as cap,
  -- Null cap means unlimited, and stays null rather than becoming a number
  -- nobody can act on. The screen already distinguishes "no limit" from "some
  -- left"; a 0 here would read as sold out.
  case
    when t.quantity is null then null
    else greatest(
      t.quantity - (
        select count(*)
          from public.event_registrations r
         where r.ticket_type_id = t.id
           and (r.status = 'confirmed'
                or (r.status = 'pending' and r.hold_expires_at > now()))
      ),
      0
    )::int
  end as remaining
from public.ticket_types t
where public.event_visible(t.event_id);

comment on view public.ticket_type_availability is
  'ORG-04. Places left on one ticket option, counted the same way enforce_event_capacity counts them. Readable by anybody who can see the event. Reports, never enforces — the trigger is the guarantee.';

-- Same reach as event_availability: an anonymous visitor on a public event
-- page has to be able to read it, and `event_visible` in the view body is
-- what keeps a draft's options out of it.
grant select on public.ticket_type_availability to anon, authenticated;
