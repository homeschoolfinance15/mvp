-- ============================================================================
-- Feedback — the most sensitive data in the platform
--
-- What somebody writes about a person they met at an event is read by
-- administrators and by nobody else. Not by the subject, not by the host, not
-- by other attendees, not by a connector, and not by the author once it is
-- submitted. FDB-09, FDB-11, FDB-12 and FDB-13 all say versions of the same
-- sentence, and the way this file honours it is blunt: there is no select
-- policy on the answer tables for anyone but is_admin().
--
-- That is deliberately stricter than "hide it in the UI". A REST API with row
-- level security has exactly one place where a promise like this can be kept,
-- and it is the policy. Everything above it is decoration.
--
-- An author still needs to know what they have left to do, which is what
-- my_feedback_progress is for: subject ids and outcomes, never answer text.
--
-- FDB-16. Questions are rows, not constants, and an answer references a
-- question id rather than a slot number. When the wording changes, a new
-- version is inserted and old answers keep pointing at the words they were
-- actually given. A slot number would silently re-label years of answers.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. feedback_questions
--
-- Seeded at version 1 with the wording in CONTRACT.md §5, character for
-- character. Changing wording means inserting version 2 and deactivating
-- version 1 — never an update in place, for the reason above.
-- ---------------------------------------------------------------------------

create table public.feedback_questions (
  id            uuid primary key default gen_random_uuid(),
  scope         text not null,
  slot          int not null,
  version       int not null default 1,
  wording       text not null,
  answer_format text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),

  constraint feedback_questions_scope_known  check (scope in ('peer', 'event')),
  constraint feedback_questions_format_known check (answer_format in ('text', 'choice', 'scale')),
  constraint feedback_questions_slot_sane    check (slot > 0),
  constraint feedback_questions_version_key  unique (scope, slot, version)
);

create index feedback_questions_live_idx
  on public.feedback_questions (scope, slot) where active;

comment on table public.feedback_questions is
  'FDB-16. The questions as asked, versioned. An answer references a question id, never a slot, so changing the wording never re-labels old answers.';

insert into public.feedback_questions (scope, slot, version, wording, answer_format) values
  ('peer',  1, 1, 'What was the best quality you noticed in this person?', 'text'),
  ('peer',  2, 1, 'Would you like to meet this person again?', 'choice'),
  ('peer',  3, 1, 'What would you most like to work on or collaborate on with this person?', 'text'),
  ('event', 1, 1, 'How was the event?', 'scale'),
  ('event', 2, 1, 'What did you enjoy the most?', 'text');

-- ---------------------------------------------------------------------------
-- 2. feedback_subjects — FDB-05
--
-- The four states, and why they need a table of their own: "I have not got to
-- them yet", "I chose not to answer", "we never actually met" and "here is
-- what I thought" are four different facts about a respondent, and three of
-- them are not an unfavourable review. Inferring them from the absence of a
-- peer_feedback row would collapse all four into silence.
--
-- Nothing seeds this table. The roster of people an author could write about
-- comes from event_attendance, and a row appears here only when the author
-- says something about that person — including saying they would rather not.
-- my_feedback_progress is where the two are put back together, defaulting the
-- missing rows to 'pending'.
-- ---------------------------------------------------------------------------

create table public.feedback_subjects (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id)   on delete cascade,
  author_id  uuid not null references public.profiles (id) on delete cascade,
  subject_id uuid not null references public.profiles (id) on delete cascade,
  outcome    feedback_outcome not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint feedback_subjects_not_self check (author_id <> subject_id),
  constraint feedback_subjects_once unique (event_id, author_id, subject_id)
);

create index feedback_subjects_author_idx on public.feedback_subjects (author_id, event_id);

comment on table public.feedback_subjects is
  'FDB-05. What an author decided about each person they met: pending, skipped, did_not_meet or submitted. Four distinguishable states, none of them a review.';

-- ---------------------------------------------------------------------------
-- 3. peer_feedback and event_feedback
--
-- Answers. One row per (author, subject, question) and per (author, question),
-- so submitting twice corrects rather than accumulates.
--
-- FDB-06: both are gated on attendance, and peer feedback additionally on the
-- subject having attended — you may write about people who were in the room
-- with you, and only those.
-- ---------------------------------------------------------------------------

create table public.peer_feedback (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events (id)             on delete cascade,
  author_id     uuid not null references public.profiles (id)           on delete cascade,
  subject_id    uuid not null references public.profiles (id)           on delete cascade,
  question_id   uuid not null references public.feedback_questions (id) on delete restrict,
  answer_text   text,
  answer_choice text,
  submitted_at  timestamptz not null default now(),

  constraint peer_feedback_not_self check (author_id <> subject_id),
  constraint peer_feedback_once unique (event_id, author_id, subject_id, question_id),
  constraint peer_feedback_choice_known
    check (answer_choice is null or answer_choice in ('Yes', 'Maybe', 'No')),
  constraint peer_feedback_has_an_answer
    check (coalesce(btrim(answer_text), answer_choice) is not null),
  constraint peer_feedback_text_length
    check (answer_text is null or length(answer_text) <= 4000)
);

create index peer_feedback_event_idx   on public.peer_feedback (event_id);
create index peer_feedback_subject_idx on public.peer_feedback (subject_id);

comment on table public.peer_feedback is
  'What one attendee said about another. Readable by administrators only — no exceptions, in policy rather than in the interface (FDB-09/11/12/13).';

create table public.event_feedback (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.events (id)             on delete cascade,
  author_id    uuid not null references public.profiles (id)           on delete cascade,
  question_id  uuid not null references public.feedback_questions (id) on delete restrict,
  answer_scale int,
  answer_text  text,
  host_ids     uuid[] not null default '{}',
  submitted_at timestamptz not null default now(),

  constraint event_feedback_once unique (event_id, author_id, question_id),
  constraint event_feedback_scale_sane
    check (answer_scale is null or answer_scale between 1 and 10),
  constraint event_feedback_has_an_answer
    check (answer_scale is not null or btrim(coalesce(answer_text, '')) <> ''),
  constraint event_feedback_text_length
    check (answer_text is null or length(answer_text) <= 4000)
);

create index event_feedback_event_idx on public.event_feedback (event_id);

comment on table public.event_feedback is
  'What an attendee said about the event itself. Admin-only on select, exactly like peer feedback — a host reading "how was the event" by name would change what people write.';
comment on column public.event_feedback.host_ids is
  'FDB-10. Who was hosting when this was written, as context. A snapshot because the hosting team changes and "how was the event" was answered about the team that ran it. Deliberately an array on the event answer, never a row per host: FDB-10 forbids turning one event rating into a rating of each individual host.';

-- FDB-10 and §9. "Record the event and its hosting team as context." Stamped
-- from the server at submission rather than read back through event_hosts
-- later, because a cohost removed next week did still run the evening this
-- answer is about.
create or replace function public.stamp_event_feedback_hosts()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  select coalesce(array_agg(h.profile_id order by h.profile_id), '{}'::uuid[])
    into new.host_ids
  from public.event_host_ids(new.event_id) h;
  return new;
end;
$$;

comment on function public.stamp_event_feedback_hosts() is
  'FDB-10. Freezes the hosting team onto an event feedback answer at the moment it is submitted.';

create trigger trg_stamp_event_feedback_hosts
  before insert on public.event_feedback
  for each row execute function public.stamp_event_feedback_hosts();

-- ---------------------------------------------------------------------------
-- 4. Submitting marks the subject done
--
-- So that the author's progress cannot disagree with what they actually wrote.
-- Doing it in application code would mean two writes and one of them failing.
-- ---------------------------------------------------------------------------

create or replace function public.mark_feedback_submitted()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.feedback_subjects (event_id, author_id, subject_id, outcome)
  values (new.event_id, new.author_id, new.subject_id, 'submitted')
  on conflict (event_id, author_id, subject_id)
  do update set outcome = 'submitted', updated_at = now();
  return null;
end;
$$;

comment on function public.mark_feedback_submitted() is
  'FDB-05. An answer is the outcome. Keeps feedback_subjects in step with peer_feedback without a second round trip that can fail on its own.';

create trigger trg_mark_feedback_submitted
  after insert on public.peer_feedback
  for each row execute function public.mark_feedback_submitted();

-- ---------------------------------------------------------------------------
-- 5. my_feedback_progress — the author's own list
--
-- Everyone else who attended, and what this author has decided about each of
-- them. Ids, names and outcomes. No answer text, not even the author's own:
-- the moment this view could return an answer it becomes the hole in the
-- admin-only rule, because "only my own" is one predicate away from "only
-- mine, said the request".
--
-- security_invoker off with the gate in the WHERE, as member_directory does
-- it. The name is included because a peer feedback form that says "person
-- 4f21…" cannot be filled in, and an event-only account cannot read
-- member_directory to look it up (ACC-05).
-- ---------------------------------------------------------------------------

create view public.my_feedback_progress
with (security_invoker = off) as
select
  a.event_id,
  auth.uid()            as author_id,
  a.profile_id          as subject_id,
  -- Cast rather than left as varchar: 20260916000010 replaces this view with
  -- one that unions in a row for the event itself, whose subject_name is a
  -- null text. A `create or replace view` cannot change a column's type, so
  -- both halves have to agree on text from the start.
  p.full_name::text     as subject_name,
  coalesce(s.outcome, 'pending'::feedback_outcome) as outcome
from public.event_attendance a
join public.profiles p on p.id = a.profile_id
left join public.feedback_subjects s
       on s.event_id = a.event_id
      and s.author_id = auth.uid()
      and s.subject_id = a.profile_id
where a.profile_id <> auth.uid()
  and public.attended_event(a.event_id, auth.uid());

comment on view public.my_feedback_progress is
  'FDB-05. Who an author still has to write about, and what they decided. Outcomes only — never answer text, theirs or anybody else''s.';

-- ---------------------------------------------------------------------------
-- 6. Row level security
--
-- The questions are readable: they are the form, not the answers. Everything
-- else on select is is_admin() and nothing more.
--
-- Insert is the author writing about an event they attended, about somebody
-- who attended it too. There is no update and no delete policy on the answer
-- tables: submitted feedback is a record of what somebody said at the time,
-- and correcting it means submitting the question again, which the unique
-- constraint turns into an upsert the author can perform through on_conflict.
-- ---------------------------------------------------------------------------

alter table public.feedback_questions enable row level security;
alter table public.feedback_subjects  enable row level security;
alter table public.peer_feedback      enable row level security;
alter table public.event_feedback     enable row level security;

create policy feedback_questions_select on public.feedback_questions for select to authenticated
using (public.has_account());

create policy feedback_questions_write on public.feedback_questions for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- FDB-09/12. Admins only. The author reads their own progress through
-- my_feedback_progress, which carries no answers.
create policy feedback_subjects_select on public.feedback_subjects for select to authenticated
using (public.is_admin());

create policy feedback_subjects_insert on public.feedback_subjects for insert to authenticated
with check (
  author_id = auth.uid()
  and author_id <> subject_id
  and public.attended_event(event_id, auth.uid())
  and public.attended_event(event_id, subject_id)
);

create policy feedback_subjects_update on public.feedback_subjects for update to authenticated
using (author_id = auth.uid())
with check (author_id = auth.uid());

create policy peer_feedback_select on public.peer_feedback for select to authenticated
using (public.is_admin());

create policy peer_feedback_insert on public.peer_feedback for insert to authenticated
with check (
  author_id = auth.uid()
  and author_id <> subject_id
  and public.attended_event(event_id, auth.uid())
  and public.attended_event(event_id, subject_id)
);

create policy event_feedback_select on public.event_feedback for select to authenticated
using (public.is_admin());

create policy event_feedback_insert on public.event_feedback for insert to authenticated
with check (
  author_id = auth.uid()
  and public.attended_event(event_id, auth.uid())
);

-- ---------------------------------------------------------------------------
-- 7. Audit
--
-- Every answer column is skipped. The activity log is readable by admins, who
-- may read feedback anyway — but a log entry outlives the row it describes and
-- survives a deletion request, and FDB-03 is clear that answers travel as
-- little as possible. The log records that feedback was given, by whom, about
-- whom. What was said stays in one table.
-- ---------------------------------------------------------------------------

create trigger log_feedback_questions
  after insert or update or delete on public.feedback_questions
  for each row execute function public.log_activity('wording');

create trigger log_feedback_subjects
  after insert or update or delete on public.feedback_subjects
  for each row execute function public.log_activity();

create trigger log_peer_feedback
  after insert or update or delete on public.peer_feedback
  for each row execute function public.log_activity('answer_text', 'answer_choice');

create trigger log_event_feedback
  after insert or update or delete on public.event_feedback
  for each row execute function public.log_activity('answer_text', 'answer_scale');

-- ---------------------------------------------------------------------------
-- 8. Grants
--
-- No select grant would be enough on its own, but the policies above are what
-- actually hold: a service-role client ignores grants and policies alike, and
-- the mailer is forbidden from putting feedback in an email by EML-09 rather
-- than by permissions.
-- ---------------------------------------------------------------------------

grant select on public.feedback_questions   to authenticated;
grant select on public.my_feedback_progress to authenticated;

grant insert, update, delete on public.feedback_questions to authenticated;
grant select, insert, update on public.feedback_subjects  to authenticated;
grant select, insert on public.peer_feedback  to authenticated;
grant select, insert on public.event_feedback to authenticated;
