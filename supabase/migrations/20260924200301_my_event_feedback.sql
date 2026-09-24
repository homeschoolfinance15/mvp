-- Decision 19. An attendee can change the feedback they sent on an event,
-- starting from what they sent. event_feedback stays admin-only to select
-- (FDB-12); this hands the author their own answers for one event and
-- nobody else's. Writing still goes through submit_event_feedback, which
-- keeps the attendance, cancelled and window checks.
create or replace function public.my_event_feedback(p_event uuid)
returns table (question_id uuid, answer_scale int, answer_text text)
language sql stable security definer set search_path = public
as $$
  select f.question_id, f.answer_scale, f.answer_text
  from public.event_feedback f
  where f.event_id = p_event and f.author_id = auth.uid()
$$;

revoke execute on function public.my_event_feedback(uuid) from public, anon;
grant execute on function public.my_event_feedback(uuid) to authenticated;
