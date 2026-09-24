-- ============================================================================
-- Closing a login with no profile, and a fuller download
--
-- ACC-01, ACC-12. delete_my_account wrote activity_log.actor_id = auth.uid()
-- before anything else. activity_log.actor_id references profiles, so a login
-- that never got a profile (a half-created event signup, anybody on the
-- NotProvisioned screen) could not be closed, and a second device still signed
-- in to a closed account got the raw foreign-key text. Now: a token whose auth
-- user is gone is told so plainly, and the audit entry names the actor only
-- when there is a profile to name.
--
-- ACC-02. export_my_data left out the questionnaire answers and everything on
-- the event platform. It now includes the person's profile answers, their own
-- registrations, tickets and orders, the event and peer feedback they wrote,
-- and the notifications they received. Still never feedback or reports about
-- them (peer_feedback.subject_id, profile_reports.subject_id).
-- ============================================================================

create or replace function public.delete_my_account(p_scope text default 'account')
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'You must be signed in.';
  end if;
  if not exists (select 1 from auth.users where id = v_me) then
    raise exception 'This account no longer exists.';
  end if;
  perform public.check_deletion_scope(p_scope);
  perform public.guard_connector_circle(v_me);

  -- Recorded before the row disappears, since the trigger's own entry will
  -- have its actor nulled by the cascade. A login with no profile has no
  -- actor to name: actor_id references profiles.
  insert into public.activity_log (actor_id, action, entity, entity_id, detail)
  values ((select id from public.profiles where id = v_me),
          'profiles.self_delete', 'profiles', v_me,
          jsonb_build_object('requested_at', now(), 'scope', p_scope));

  perform public.erase_subject_data(v_me, p_scope);

  delete from auth.users where id = v_me;
end;
$$;

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
    'profile_answers', (select to_jsonb(x) from public.profile_answers x where x.profile_id = v_me),
    'posts', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from public.posts x where x.author_id = v_me),
    'comments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                   from public.post_comments x where x.author_id = v_me),
    'likes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from public.post_likes x where x.profile_id = v_me),
    'circle_messages', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                          from public.circle_messages x where x.author_id = v_me),
    'events_hosted', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                        from public.events x
                       where x.host_id = v_me
                          or exists (select 1 from public.event_hosts h
                                      where h.event_id = x.id and h.profile_id = v_me)),
    'rsvps', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from public.event_invitations x where x.profile_id = v_me),
    'event_registrations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                              from public.event_registrations x where x.profile_id = v_me),
    'event_tickets', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                        from public.event_tickets x where x.profile_id = v_me),
    'event_orders', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                       from public.event_orders x where x.profile_id = v_me),
    'event_attendance', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                           from public.event_attendance x where x.profile_id = v_me),
    'event_feedback_i_wrote', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                                 from public.event_feedback x where x.author_id = v_me),
    'peer_feedback_i_wrote', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                                from public.peer_feedback x where x.author_id = v_me),
    'notifications', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                        from public.notifications x where x.profile_id = v_me),
    'reports_i_raised', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                           from public.profile_reports x where x.reporter_id = v_me),
    'recommendations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                          from public.recommendations x where x.profile_id = v_me),
    'my_activity', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                      from public.activity_log x where x.actor_id = v_me)
  );
end;
$$;

-- create or replace keeps existing grants; restated so this file stands alone.
revoke execute on function public.delete_my_account(text) from public, anon;
revoke execute on function public.export_my_data()       from public, anon;
grant  execute on function public.delete_my_account(text) to authenticated;
grant  execute on function public.export_my_data()       to authenticated;
