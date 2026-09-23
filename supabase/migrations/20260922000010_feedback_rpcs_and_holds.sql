-- ============================================================================
-- Feedback is written through functions, and nobody holds a place by hand
--
-- ATT-1. The feedback screen upserted into event_feedback, peer_feedback and
-- feedback_subjects. INSERT ... ON CONFLICT is checked against the table's
-- SELECT policy as well as its insert and update policies, and select on all
-- three is is_admin() and nothing else (FDB-09/12). So every submit from an
-- attendee failed with 42501, first time and every retry, and no feedback of
-- any kind could be saved from the UI. A plain INSERT passed, which is why
-- check-acceptance.mjs never noticed.
--
-- Opening select to the author is not the fix: "only my own" is one predicate
-- away from the hole FDB-12 closes. Instead the upsert moves into three
-- SECURITY DEFINER functions that re-check what the insert policies check —
-- author = auth.uid(), attended the event, the subject attended too, not
-- yourself — and do the ON CONFLICT on the server. Select stays admin-only.
--
-- ATT-5. An answer must attach to a question of its own scope. Checked by a
-- trigger rather than inside the functions, so the direct insert the policies
-- still allow cannot store a peer answer as an event answer either.
--
-- No time gate on submitting yet: that is decision ATT-4 / ORG-23.
--
-- ATT-2. The self branch of event_registrations_insert let an attendee POST
-- {status: 'pending', hold_expires_at: '2099-01-01'} for themselves, and
-- enforce_event_capacity counts an unexpired hold, so one request made any
-- capacity-limited event sold out until 2099. Nothing needs the branch:
-- register_free() is SECURITY DEFINER and stripe-checkout writes its
-- 20-minute hold with the service role (BUY-06). It goes. Hosts and admins
-- keep the guest path (ORG-09).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ATT-5 — an answer belongs to a question of its own scope
-- ---------------------------------------------------------------------------

create or replace function public.feedback_answer_scope_matches()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- TG_ARGV[0] is the scope this table answers: 'event' or 'peer'.
  if not exists (
    select 1 from public.feedback_questions q
    where q.id = new.question_id and q.scope = tg_argv[0]
  ) then
    raise exception 'That question does not belong on this form.' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.feedback_answer_scope_matches() from public, anon, authenticated;

drop trigger if exists trg_event_feedback_scope on public.event_feedback;
create trigger trg_event_feedback_scope
  before insert or update of question_id on public.event_feedback
  for each row execute function public.feedback_answer_scope_matches('event');

drop trigger if exists trg_peer_feedback_scope on public.peer_feedback;
create trigger trg_peer_feedback_scope
  before insert or update of question_id on public.peer_feedback
  for each row execute function public.feedback_answer_scope_matches('peer');

-- ---------------------------------------------------------------------------
-- 2. ATT-1 — the three writes the feedback screen makes
--
-- p_answers is a json array of {question_id, answer_text, answer_scale} for
-- the event form and {question_id, answer_text, answer_choice} for a person.
-- Returns nothing: select is admin-only, and a write that hands the row back
-- would be the author reading their own review (FDB-12).
-- ---------------------------------------------------------------------------

create or replace function public.submit_event_feedback(p_event uuid, p_answers jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.attended_event(p_event, auth.uid()) then
    raise exception 'Only people who attended this event can give feedback on it.' using errcode = '42501';
  end if;

  insert into public.event_feedback (event_id, author_id, question_id, answer_scale, answer_text, submitted_at)
  select p_event, auth.uid(), a.question_id, a.answer_scale, nullif(btrim(a.answer_text), ''), now()
  from jsonb_to_recordset(coalesce(p_answers, '[]'::jsonb))
       as a(question_id uuid, answer_scale int, answer_text text)
  on conflict (event_id, author_id, question_id) do update
    set answer_scale = excluded.answer_scale,
        answer_text  = excluded.answer_text,
        submitted_at = excluded.submitted_at;
end;
$$;

create or replace function public.submit_peer_feedback(p_event uuid, p_subject uuid, p_answers jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or p_subject = auth.uid()
     or not public.attended_event(p_event, auth.uid())
     or not public.attended_event(p_event, p_subject) then
    raise exception 'You can only give feedback on someone else who attended this event with you.' using errcode = '42501';
  end if;

  -- trg_mark_feedback_submitted moves the subject to 'submitted' on both the
  -- insert and the update half of this.
  insert into public.peer_feedback (event_id, author_id, subject_id, question_id, answer_text, answer_choice, submitted_at)
  select p_event, auth.uid(), p_subject, a.question_id, nullif(btrim(a.answer_text), ''), a.answer_choice, now()
  from jsonb_to_recordset(coalesce(p_answers, '[]'::jsonb))
       as a(question_id uuid, answer_text text, answer_choice text)
  on conflict (event_id, author_id, subject_id, question_id) do update
    set answer_text   = excluded.answer_text,
        answer_choice = excluded.answer_choice,
        submitted_at  = excluded.submitted_at;
end;
$$;

create or replace function public.set_feedback_outcome(p_event uuid, p_subject uuid, p_outcome feedback_outcome)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null or p_subject = auth.uid()
     or not public.attended_event(p_event, auth.uid())
     or not public.attended_event(p_event, p_subject) then
    raise exception 'You can only give feedback on someone else who attended this event with you.' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome = 'pending' then
    raise exception 'Choose what happened with this person.' using errcode = '22023';
  end if;

  insert into public.feedback_subjects (event_id, author_id, subject_id, outcome)
  values (p_event, auth.uid(), p_subject, p_outcome)
  on conflict (event_id, author_id, subject_id)
  do update set outcome = excluded.outcome, updated_at = now();
end;
$$;

revoke execute on function public.submit_event_feedback(uuid, jsonb)                  from public, anon;
revoke execute on function public.submit_peer_feedback(uuid, uuid, jsonb)             from public, anon;
revoke execute on function public.set_feedback_outcome(uuid, uuid, feedback_outcome)  from public, anon;
grant  execute on function public.submit_event_feedback(uuid, jsonb)                  to authenticated;
grant  execute on function public.submit_peer_feedback(uuid, uuid, jsonb)             to authenticated;
grant  execute on function public.set_feedback_outcome(uuid, uuid, feedback_outcome)  to authenticated;

comment on function public.submit_event_feedback(uuid, jsonb) is
  'ATT-1, FDB-08. An attendee''s answers about the event, upserted on the natural key so a retry overwrites. Returns nothing (FDB-12).';
comment on function public.submit_peer_feedback(uuid, uuid, jsonb) is
  'ATT-1, FDB-07. An attendee''s answers about another attendee, upserted on the natural key. Returns nothing (FDB-12).';
comment on function public.set_feedback_outcome(uuid, uuid, feedback_outcome) is
  'ATT-1, FDB-05. Submitted, skipped or did-not-meet for one person the author attended with.';

-- ---------------------------------------------------------------------------
-- 3. ATT-2 — nobody writes their own registration row
-- ---------------------------------------------------------------------------

drop policy if exists event_registrations_insert on public.event_registrations;

create policy event_registrations_insert on public.event_registrations for insert to authenticated
with check (
  public.has_account()
  and (public.hosts_event(event_id) or public.is_admin())
);

comment on policy event_registrations_insert on public.event_registrations is
  'BUY-03, BUY-04, BUY-06, ORG-09. Hosts and admins may register a guest. An attendee''s own row is written only by register_free() or by stripe-checkout with a 20-minute hold — never directly, because a direct pending row could hold a place until any date it named (ATT-2).';
