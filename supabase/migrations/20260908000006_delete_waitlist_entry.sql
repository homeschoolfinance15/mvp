-- ============================================================================
-- Removing a waitlist entry
--
-- waitlist_entries had an insert policy and a select policy and nothing else,
-- so a row written by anybody on the internet could never be taken out again
-- except by hand in the SQL editor. Test submissions, duplicates and spam all
-- accumulated with no way to clear them.
--
-- Deliberately not a delete POLICY: a policy would let an admin delete rows
-- with a bare DELETE from the browser, and this is personal data somebody
-- submitted. A function is one named, audited verb instead — log_waitlist_entries
-- already records deletes, so who removed what stays on the record.
--
-- Declining is still the normal answer. This is for entries that should never
-- have existed rather than people who were turned down.
-- ============================================================================

create or replace function public.delete_waitlist_entry(p_entry_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete a waitlist entry.';
  end if;

  delete from public.waitlist_entries where id = p_entry_id;

  if not found then
    raise exception 'That waitlist entry no longer exists.';
  end if;
end;
$$;

grant execute on function public.delete_waitlist_entry(uuid) to authenticated;

comment on function public.delete_waitlist_entry(uuid) is
  'Admin only. Removes a waitlist row entirely, with its answers. Declining is the softer option.';
