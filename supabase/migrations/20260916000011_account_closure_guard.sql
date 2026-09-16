-- ============================================================================
-- Closing an account must not lose somebody's money
--
-- REQUIREMENTS §9, "Account changes and removal": closing or changing an
-- account must not "make outstanding bookings, payments, and refunds
-- unmanageable".
--
-- Today it can. delete_my_account() deletes the auth user and every foreign
-- key in the schema cascades from there, which was a deliberate and correct
-- answer while the only thing cascading was posts and RSVPs — erasure over
-- retention, with the audit trail surviving and its actor nulled. The event
-- platform adds orders and refunds to that cascade, and a refund that Stripe
-- is halfway through processing is not the same kind of row as a like on a
-- post. Deleting it leaves money moving with nothing on our side describing
-- where it is going or who it belongs to.
--
-- So one rule: an account with a refund in flight cannot be deleted until the
-- refund settles. Requested and processing are the two states where somebody
-- is owed money and the answer is not yet known. Completed, failed and
-- needs_attention are all resolved enough to talk about.
--
-- This is a BEFORE DELETE trigger on profiles rather than a check inside
-- delete_my_account(), because that is not the only way a profile goes away:
-- delete_managed_profile() removes somebody as an admin action, a cascade
-- from auth.users removes them when the auth record goes, and a script or a
-- psql session removes them when somebody is tidying up. A guard in one
-- function protects one caller. A guard on the table protects the fact.
--
-- What this deliberately does NOT do, because it is a product decision rather
-- than a schema one, and the primary agent should make it:
--
--   Deleting an account still destroys its completed orders, refunds,
--   tickets and attendance, because every one of those foreign keys is
--   `on delete cascade` to profiles. §9 also wants payment history to stay
--   understandable, and financial record-keeping obligations usually outlast
--   an erasure request. Reconciling those two is a decision about what
--   Amazing promises people, and the answer is either "anonymise the person
--   and keep the order" — profile_id nullable, a retained name snapshot — or
--   "refuse deletion outright while any order exists". Both are larger than a
--   guard and neither should be chosen by a migration on its own.
--
-- ponytail: refuses, rather than offering an admin override. Add one when
-- somebody is actually stuck, and make it an audited admin action when you
-- do — a quiet override is how the rule stops meaning anything.
-- ============================================================================

create or replace function public.guard_account_closure()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if exists (
    select 1
    from public.event_refunds r
    join public.event_orders o on o.id = r.order_id
    where o.profile_id = old.id
      and r.status in ('requested', 'processing')
  ) then
    raise exception
      'This account has a refund still in progress. It can be closed once the refund settles.';
  end if;

  return old;
end;
$$;

comment on function public.guard_account_closure() is
  '§9. Refuses to delete a profile while a refund is in flight, so money never moves with nobody attached to it. Every caller, not just delete_my_account().';

create trigger trg_guard_account_closure
  before delete on public.profiles
  for each row execute function public.guard_account_closure();
