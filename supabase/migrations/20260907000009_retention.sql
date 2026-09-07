-- ============================================================================
-- Retention and erasure
--
-- Two things this platform had no answer for, and both are ordinary
-- expectations for a system holding personal data:
--
--   1. How long is the audit trail kept? "Forever" is not a retention
--      policy, it is the absence of one, and an unbounded log of who did
--      what is a growing liability rather than a control.
--
--   2. Can a person take their data with them, and can they leave? There was
--      a way for an ADMIN to delete somebody (delete_managed_profile). There
--      was no way for a member to export what is held about them, and no way
--      for them to close their own account.
--
-- None of this makes anybody SOC 2 compliant on its own — that is an audit
-- of an organisation, not a property of a schema. These are the controls a
-- schema can actually hold up.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Audit retention
--
-- Eighteen months: long enough to investigate something reported late, short
-- enough that the log does not become an indefinite archive of behaviour.
-- Deliberately a function rather than a trigger, so deletion is a scheduled,
-- observable act and not a side effect of writing.
-- ---------------------------------------------------------------------------

create or replace function public.purge_activity_log(p_keep_days int default 548)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_deleted int;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can purge the activity log.';
  end if;
  if p_keep_days < 30 then
    raise exception 'Refusing to keep less than 30 days of audit history.';
  end if;

  delete from public.activity_log
  where created_at < now() - make_interval(days => p_keep_days);

  get diagnostics v_deleted = row_count;

  -- The purge is itself an audited event. A log that can be silently
  -- trimmed is not evidence of anything.
  insert into public.activity_log (actor_id, action, entity, detail)
  values (
    auth.uid(),
    'activity_log.purge',
    'activity_log',
    jsonb_build_object('kept_days', p_keep_days, 'rows_deleted', v_deleted)
  );

  return v_deleted;
end;
$$;

comment on function public.purge_activity_log(int) is
  'Deletes audit rows older than the retention window (default 548 days) and records that it did so.';

-- ---------------------------------------------------------------------------
-- 2. Subject access — everything the platform holds about you, in one call
--
-- SECURITY DEFINER so it can gather rows the caller cannot select directly
-- (their own audit trail), while never returning anybody else's. Note what
-- is deliberately absent: the reports other people have filed about them.
-- Handing those over would expose the reporter and undo the one rule the
-- trust layer depends on.
-- ---------------------------------------------------------------------------

create or replace function public.export_my_data()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'You must be signed in.';
  end if;

  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = v_me),
    'posts', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from public.posts x where x.author_id = v_me),
    'comments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                   from public.post_comments x where x.author_id = v_me),
    'likes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from public.post_likes x where x.profile_id = v_me),
    'circle_messages', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                          from public.circle_messages x where x.author_id = v_me),
    'events_hosted', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                        from public.events x where x.host_id = v_me),
    'rsvps', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from public.event_invitations x where x.profile_id = v_me),
    'reports_i_raised', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                           from public.profile_reports x where x.reporter_id = v_me),
    'recommendations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                          from public.recommendations x where x.profile_id = v_me),
    'my_activity', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                      from public.activity_log x where x.actor_id = v_me)
  );
end;
$$;

comment on function public.export_my_data() is
  'Everything the platform holds about the caller. Excludes reports filed about them, which would expose the reporter.';

-- ---------------------------------------------------------------------------
-- 3. Leaving
--
-- A member could always be removed by an admin; they could not remove
-- themselves. This deletes the auth user, and every foreign key in the
-- schema cascades from there — posts, comments, likes, messages, RSVPs,
-- recommendations, notes written about them, and the links recording who
-- invited them.
--
-- The audit trail survives on purpose: actor_id is ON DELETE SET NULL, so
-- what happened is still recorded while who did it stops being identifiable.
-- That is the shape a retention policy and an erasure right can both live
-- with.
--
-- An administrator cannot use this to delete somebody else — it acts only on
-- the caller. Removing another person stays with delete_managed_profile,
-- which is audited as an admin action.
-- ---------------------------------------------------------------------------

create or replace function public.delete_my_account()
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'You must be signed in.';
  end if;

  -- Recorded before the row disappears, since the trigger's own entry will
  -- have its actor nulled by the cascade.
  insert into public.activity_log (actor_id, action, entity, entity_id, detail)
  values (v_me, 'profiles.self_delete', 'profiles', v_me,
          jsonb_build_object('requested_at', now()));

  delete from auth.users where id = v_me;
end;
$$;

comment on function public.delete_my_account() is
  'Closes the caller''s own account. Cascades through every table; the audit trail keeps the event and loses the actor.';

grant execute on function public.purge_activity_log(int) to authenticated;
grant execute on function public.export_my_data()        to authenticated;
grant execute on function public.delete_my_account()     to authenticated;
