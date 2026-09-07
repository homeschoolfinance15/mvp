-- ============================================================================
-- The audit trail must survive the actor deleting themselves
--
-- Bug introduced by the foundation migration and caught by the first test of
-- delete_my_account:
--
--   insert or update on table "activity_log" violates foreign key constraint
--   "activity_log_actor_id_fkey"
--
-- Deleting a profile fires log_profiles AFTER DELETE, which writes a row with
-- actor_id = auth.uid(). When the actor is the person being deleted, their
-- profile is already gone by the time the trigger runs, and the foreign key
-- refuses the row — so the whole delete rolls back.
--
-- It only bites when actor and subject are the same person, which is why
-- an admin removing somebody else always worked and self-deletion never did.
-- delete_managed_profile has the same hole for an admin removing their own
-- account, and this fixes both.
--
-- The fix keeps the foreign key rather than dropping it. actor_id is
-- ON DELETE SET NULL on purpose: an erased person should stop being
-- identifiable in the log while the events they caused remain. Resolving the
-- actor through profiles gives exactly that — null when they are gone,
-- instead of an error.
-- ============================================================================

create or replace function public.log_activity()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_skip   text[] := coalesce(tg_argv, '{}'::text[]);
  v_row    jsonb;
  v_detail jsonb;
  v_actor  uuid;
begin
  -- NEW is null on DELETE, OLD is null on INSERT. Branching beats
  -- coalesce() here: the two are record variables, not plain values.
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

  -- Null rather than a dangling reference when the actor is deleting
  -- themselves and their profile has already gone.
  select p.id into v_actor from public.profiles p where p.id = auth.uid();

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(o.key, jsonb_build_object('from', o.value, 'to', n.value))
      into v_detail
    from jsonb_each(to_jsonb(old)) o
    join jsonb_each(to_jsonb(new)) n using (key)
    where o.value is distinct from n.value
      and not (o.key = any (v_skip));

    if v_detail is null then
      return null;
    end if;
  else
    select jsonb_object_agg(key, value) into v_detail
    from jsonb_each(v_row)
    where not (key = any (v_skip));
  end if;

  insert into public.activity_log (actor_id, action, entity, entity_id, detail)
  values (
    v_actor,
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    nullif(v_row ->> 'id', '')::uuid,
    v_detail
  );

  return null;
end;
$$;

-- delete_my_account writes its own entry before the delete, so that one is
-- recorded while the actor still exists — and then loses its actor to the
-- cascade, which is the intended end state.
