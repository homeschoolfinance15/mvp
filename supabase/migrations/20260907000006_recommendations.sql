-- ============================================================================
-- Recommendations
--
-- What each member should look at next, and why: people worth meeting, posts
-- worth reading, events worth going to. Written by a scheduled job that asks
-- Claude to rank a candidate set; read by the member it belongs to and
-- nobody else.
--
-- Why no embeddings and no pgvector here:
--
-- search_documents has sat in this schema since the first migration with an
-- embedding column nothing writes to. It is the right substrate at scale,
-- and it is the wrong tool for a network of this size — a few hundred
-- people and a few thousand posts fit in a prompt. Ranking them directly
-- also produces the one thing a cosine distance cannot: a sentence saying
-- why these two people should talk. Anthropic has no embeddings API, so
-- vectors would mean a second provider for a worse answer.
--
-- Revisit when the candidate set stops fitting in a prompt. Then
-- search_documents earns its keep as a pre-filter, and this table does not
-- have to change.
-- ============================================================================

create table public.recommendations (
  id         uuid primary key default gen_random_uuid(),
  -- Who this is for.
  profile_id uuid not null references public.profiles (id) on delete cascade,

  -- Exactly one of these three is set. Real foreign keys rather than a
  -- polymorphic (kind, target_id) pair, so deleting a post takes its
  -- recommendations with it instead of leaving a row pointing at nothing.
  member_id  uuid references public.profiles (id) on delete cascade,
  post_id    uuid references public.posts (id)    on delete cascade,
  event_id   uuid references public.events (id)   on delete cascade,

  reason     text not null,
  rank       int  not null,
  -- One run, so a batch can be shown or discarded as a unit.
  batch_id   uuid not null,
  -- The learning signal: set when the member actually acts on this.
  acted_at   timestamptz,
  created_at timestamptz not null default now(),

  constraint recommendations_one_target check (
    (member_id is not null)::int
  + (post_id   is not null)::int
  + (event_id  is not null)::int = 1
  ),
  constraint recommendations_not_self
    check (member_id is null or member_id <> profile_id),
  constraint recommendations_reason
    check (length(btrim(reason)) > 0 and length(reason) <= 400)
);

create index recommendations_profile_idx on public.recommendations (profile_id, created_at desc);
create index recommendations_batch_idx   on public.recommendations (batch_id);

comment on table public.recommendations is
  'Per-member suggestions with a stated reason. Written by the recommend edge function, readable only by their subject.';

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Yours and only yours. There is deliberately no insert policy: the only
-- writer is the scheduled job, which runs as service_role and bypasses RLS.
-- Nothing a browser holds can manufacture a recommendation.
-- ---------------------------------------------------------------------------

alter table public.recommendations enable row level security;

create policy recommendations_select on public.recommendations for select to authenticated
using (profile_id = auth.uid());

-- Marking one as acted on. The trigger below pins everything except
-- acted_at, so this cannot be used to rewrite the reason or the ranking.
create policy recommendations_update on public.recommendations for update to authenticated
using (profile_id = auth.uid())
with check (profile_id = auth.uid());

create or replace function public.protect_recommendation_fields()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.id         := old.id;
  new.profile_id := old.profile_id;
  new.member_id  := old.member_id;
  new.post_id    := old.post_id;
  new.event_id   := old.event_id;
  new.reason     := old.reason;
  new.rank       := old.rank;
  new.batch_id   := old.batch_id;
  new.created_at := old.created_at;
  return new;
end;
$$;

comment on function public.protect_recommendation_fields() is
  'A member may set acted_at and nothing else. The same shape as protect_profile_fields.';

create trigger trg_protect_recommendation_fields
  before update on public.recommendations
  for each row execute function public.protect_recommendation_fields();

-- ---------------------------------------------------------------------------
-- How well is it doing?
--
-- The honest measure of "the algorithm is getting better" is whether people
-- act on what it suggests. One view, so the answer is a query rather than a
-- feeling — and so the next run can be handed its own past hit rate.
-- ---------------------------------------------------------------------------

create view public.recommendation_performance
with (security_invoker = off) as
select
  r.batch_id,
  min(r.created_at)                                     as ran_at,
  count(*)                                              as suggested,
  count(r.acted_at)                                     as acted_on,
  round(count(r.acted_at)::numeric / count(*), 3)       as hit_rate
from public.recommendations r
where public.is_admin()
group by r.batch_id;

comment on view public.recommendation_performance is
  'Per-run hit rate. Whether the recommender is improving is a measurement, not an impression.';

revoke all on public.recommendation_performance from anon, authenticated;
grant select on public.recommendation_performance to authenticated;

-- ---------------------------------------------------------------------------
-- Audit
--
-- The reason text is skipped: it is model output already stored in the row,
-- and copying it into the log doubles the storage for nothing.
-- ---------------------------------------------------------------------------

create trigger log_recommendations
  after insert or update or delete on public.recommendations
  for each row execute function public.log_activity('reason');

-- ---------------------------------------------------------------------------
-- Grants — select and update only. Insert belongs to the job.
-- ---------------------------------------------------------------------------

grant select, update on public.recommendations to authenticated;
