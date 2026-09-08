-- ============================================================================
-- Turning somebody down
--
-- Assign was the only verb the waitlist had. An admin who decided against
-- somebody had nothing to press, so the entry sat in the list forever and the
-- next admin had to make the same decision again with no record that it had
-- already been made.
--
-- Declining is reversible and keeps the row: the applicant's answers are the
-- evidence for the decision, and deleting them would also lose the fact that
-- they ever applied. Nothing is shown to the applicant either way.
-- ============================================================================

alter table public.waitlist_entries
  add column declined_at timestamptz,
  add column declined_by uuid references public.profiles (id) on delete set null;

comment on column public.waitlist_entries.declined_at is
  'Set when an admin decided against this applicant. Reversible; the row and its answers stay.';

-- One function for both directions. A separate undecline_waitlist_entry would
-- be the same twelve lines with one boolean flipped.
create or replace function public.set_waitlist_declined(
  p_entry_id uuid,
  p_declined  boolean
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_assigned timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can decline a waitlist entry.';
  end if;

  select assigned_at into v_assigned
  from public.waitlist_entries
  where id = p_entry_id
  for update;

  if not found then
    raise exception 'That waitlist entry no longer exists.';
  end if;

  -- Somebody already handed a code cannot be declined behind their back. Take
  -- the code away first, which is a decision with its own audit trail.
  if v_assigned is not null and p_declined then
    raise exception 'That person has already been assigned a connector.';
  end if;

  update public.waitlist_entries
  set declined_at = case when p_declined then now() else null end,
      declined_by = case when p_declined then auth.uid() else null end
  where id = p_entry_id;
end;
$$;

grant execute on function public.set_waitlist_declined(uuid, boolean) to authenticated;

comment on function public.set_waitlist_declined(uuid, boolean) is
  'Admin only. Marks a waitlist applicant as declined, or clears that mark.';
