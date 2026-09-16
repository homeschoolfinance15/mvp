-- ============================================================================
-- Erasure: redact, retain, expire
--
-- The framing in 20260916000011 was wrong, and being wrong is why it read as
-- unresolvable. It is not erasure versus financial history. GDPR Article
-- 17(3)(b) and (e) say the right to erasure does not apply where retention is
-- necessary for compliance with a legal obligation, or for the establishment,
-- exercise or defence of legal claims; Companies Act 2006 s.388 requires
-- accounting records for six years. Retaining an order is not a balance struck
-- against a right — it is an exemption the law already grants, and the job is
-- to implement it properly rather than to agonise over it.
--
-- Implementing it properly means three things, and we had one of them.
--
--   REDACT   the person becomes a stable pseudonym, not a blank. Nulling the
--            reference — which is what ..0016 did — loses linkage: we can no
--            longer answer "were these three disputed refunds the same
--            person?", which is the exact question Article 17(3)(e) preserves
--            our right to answer. It also reads as missing data rather than as
--            a fact about the record.
--
--   RETAIN   with the lawful basis written down per table, so a DPO can answer
--            "why do you still have this" one table at a time instead of
--            arguing about the system as a whole.
--
--   EXPIRE   which we did not have at all, and whose absence is its own
--            violation. Article 5(1)(e), storage limitation: retention with no
--            end is not a retention policy.
--
-- Once auth.users is gone, the retained uuid identifies nobody outside this
-- system. That is what Article 4(5) means by pseudonymisation, and it is what
-- Stripe, Shopify, Eventbrite, Airbnb and Uber all converged on independently.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. How long
--
-- Six years is the statutory minimum under s.388. The seventh covers the
-- financial-year boundary — a record made in month one of a year is otherwise
-- destroyed before the year containing it is six years old — which is the
-- convention every comparable retention schedule uses.
--
-- A function rather than a literal so that shortening it is one line here and
-- not a hunt through three call sites.
-- ---------------------------------------------------------------------------

create or replace function public.erasure_retention_years()
returns int
language sql immutable
as $$ select 7 $$;

comment on function public.erasure_retention_years() is
  'Companies Act 2006 s.388 requires six years of accounting records; the seventh covers the financial-year boundary. Change here and nowhere else.';

-- ---------------------------------------------------------------------------
-- 2. The register of erasures
--
-- subject_id deliberately has no foreign key. The profile it names is gone —
-- that is the whole point — so a reference would be impossible to satisfy.
--
-- ponytail: the pseudonym is four hex characters off the uuid, so two erased
-- people in sixty-five thousand can share a label. It is a label, not a key:
-- erased_subject_id is what actually links rows, and it cannot collide. Widen
-- to six characters if a human ever reports seeing the same one twice.
-- ---------------------------------------------------------------------------

create table public.data_subject_erasures (
  subject_id      uuid primary key,
  pseudonym       text not null,
  erased_at       timestamptz not null default now(),
  retention_until date not null,
  lawful_basis    text not null,

  constraint data_subject_erasures_basis_known
    check (lawful_basis in ('legal_obligation', 'legal_claims'))
);

create index data_subject_erasures_expiry_idx
  on public.data_subject_erasures (retention_until);

comment on table public.data_subject_erasures is
  'GDPR Art. 17(3)(b)/(e) and Art. 5(1)(e). One row per closed account whose records were retained under an exemption: the pseudonym they now appear as, why they were kept, and the date they must be destroyed.';
comment on column public.data_subject_erasures.subject_id is
  'The profile that was erased. No foreign key, deliberately — the row it named no longer exists, which is what makes this pseudonymised rather than personal data (Art. 4(5)).';
comment on column public.data_subject_erasures.retention_until is
  'Hard stop. purge_expired_erasures() destroys everything carrying this subject_id on or after this date.';

-- ---------------------------------------------------------------------------
-- 3. The retained rows learn who they used to belong to
--
-- profile_id still goes null — the foreign key requires it once the profile is
-- deleted — and erased_subject_id carries the linkage the null threw away.
--
-- The lawful basis is recorded per table rather than per system, because that
-- is the granularity the question gets asked at.
-- ---------------------------------------------------------------------------

alter table public.event_orders     add column erased_subject_id uuid;
alter table public.event_attendance add column erased_subject_id uuid;
alter table public.peer_feedback    add column erased_subject_id uuid;
alter table public.event_feedback   add column erased_subject_id uuid;

create index event_orders_erased_idx     on public.event_orders (erased_subject_id)
  where erased_subject_id is not null;
create index event_attendance_erased_idx on public.event_attendance (erased_subject_id)
  where erased_subject_id is not null;

comment on column public.event_orders.erased_subject_id is
  'Lawful basis: legal obligation (Companies Act 2006 s.388, accounting records) and legal claims (chargeback defence). Two orders carrying the same value were the same person, which is what a dispute needs and what nulling alone destroyed.';
comment on column public.event_attendance.erased_subject_id is
  'Lawful basis: legal claims. Who was admitted to a room is the record that answers a later dispute about it, and an attendance total that silently drops is not a record.';
comment on column public.peer_feedback.erased_subject_id is
  'Lawful basis: legal claims, and the rights of a third party. A review is also the subject''s record — erasing it to satisfy the author rewrites somebody else''s history, and §9 exists to tell a one-off from a repeated pattern.';
comment on column public.event_feedback.erased_subject_id is
  'Lawful basis: legal claims. This answer is about the event, not about a person; the author is pseudonymised and the answer stands.';

-- ---------------------------------------------------------------------------
-- 4. Feedback: the two directions stop being the same question
--
-- Both cascaded. They should not, and the split is the same one Airbnb and
-- Trustpilot make:
--
--   subject_id  stays cascade. It is personal data about them, and they asked
--               to go.
--   author_id   becomes set null. The review is also the subject's record, and
--               cascading it rewrites Sarah's history to satisfy a request that
--               was never about Sarah.
--
-- The check constraint survives a null author: `null <> subject_id` evaluates
-- to null, and a CHECK passes on null. The unique keys survive it too, because
-- nulls do not collide — several erased authors can hold rows on one event
-- without fighting over the index.
--
-- event_feedback.host_ids is untouched, as decided: stripping it would rewrite
-- what an answer was given about.
-- ---------------------------------------------------------------------------

alter table public.peer_feedback alter column author_id drop not null;
alter table public.peer_feedback drop constraint if exists peer_feedback_author_id_fkey;
alter table public.peer_feedback
  add constraint peer_feedback_author_id_fkey
  foreign key (author_id) references public.profiles (id) on delete set null;

alter table public.event_feedback alter column author_id drop not null;
alter table public.event_feedback drop constraint if exists event_feedback_author_id_fkey;
alter table public.event_feedback
  add constraint event_feedback_author_id_fkey
  foreign key (author_id) references public.profiles (id) on delete set null;

-- ---------------------------------------------------------------------------
-- 5. Redaction happens before the delete, in one place
--
-- A BEFORE DELETE trigger on profiles, so it runs while profile_id is still
-- readable and before the foreign keys null it. Every caller is covered:
-- delete_my_account(), delete_managed_profile(), an auth.users cascade, or
-- somebody tidying up in psql.
--
-- It sorts after trg_guard_account_closure alphabetically, which is the order
-- that matters: the guard aborts a deletion with money in flight before any of
-- this has happened.
-- ---------------------------------------------------------------------------

create or replace function public.record_data_subject_erasure()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_pseudonym text;
begin
  v_pseudonym := 'Former attendee ' || upper(substr(replace(old.id::text, '-', ''), 1, 4));

  insert into public.data_subject_erasures
    (subject_id, pseudonym, retention_until, lawful_basis)
  values (
    old.id,
    v_pseudonym,
    (now() + make_interval(years => public.erasure_retention_years()))::date,
    'legal_obligation'
  )
  on conflict (subject_id) do nothing;

  update public.event_orders     set erased_subject_id = old.id where profile_id = old.id;
  update public.event_attendance set erased_subject_id = old.id where profile_id = old.id;
  update public.peer_feedback    set erased_subject_id = old.id where author_id  = old.id;
  update public.event_feedback   set erased_subject_id = old.id where author_id  = old.id;

  return old;
end;
$$;

comment on function public.record_data_subject_erasure() is
  'GDPR Art. 17(3)/4(5). Redacts a departing person to a stable pseudonym and stamps the retained rows with the id that links them, before the foreign keys null the reference.';

create trigger trg_record_data_subject_erasure
  before delete on public.profiles
  for each row execute function public.record_data_subject_erasure();

-- ---------------------------------------------------------------------------
-- 6. Expiry — Art. 5(1)(e)
--
-- The half that was missing. Retained rows are destroyed outright once the
-- retention period is up; there is nothing left to pseudonymise by then.
--
-- NOT SCHEDULED, deliberately, and it needs to be. purge_activity_log() from
-- 20260907000009 is in the same position and has been since it was written, so
-- this is the second unscheduled retention job rather than the first. Schedule
-- both together — monthly is ample for a date-based expiry — and until somebody
-- does, this database retains past its own stated limit.
-- ---------------------------------------------------------------------------

create or replace function public.purge_expired_erasures()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_subjects int;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can purge expired records.';
  end if;

  delete from public.event_orders o
   using public.data_subject_erasures e
   where o.erased_subject_id = e.subject_id and e.retention_until <= current_date;

  delete from public.event_attendance a
   using public.data_subject_erasures e
   where a.erased_subject_id = e.subject_id and e.retention_until <= current_date;

  delete from public.peer_feedback f
   using public.data_subject_erasures e
   where f.erased_subject_id = e.subject_id and e.retention_until <= current_date;

  delete from public.event_feedback f
   using public.data_subject_erasures e
   where f.erased_subject_id = e.subject_id and e.retention_until <= current_date;

  delete from public.data_subject_erasures where retention_until <= current_date;
  get diagnostics v_subjects = row_count;

  -- The purge is itself an audited act, exactly as purge_activity_log() is. A
  -- retention policy that can run silently is not evidence of anything.
  insert into public.activity_log (actor_id, action, entity, detail)
  values (auth.uid(), 'data_subject_erasures.purge', 'data_subject_erasures',
          jsonb_build_object('subjects_purged', v_subjects));

  return v_subjects;
end;
$$;

comment on function public.purge_expired_erasures() is
  'GDPR Art. 5(1)(e). Destroys retained records whose retention period has ended. Needs a schedule and does not have one — pair it with purge_activity_log(), which is in the same position.';

-- ---------------------------------------------------------------------------
-- 7. Row level security
--
-- Admin only, and no write policy at all: the register is written by the
-- definer trigger above and by nothing else. Linkage analysis — "were these
-- the same person" — is an administrator's job and is the activity the lawful
-- basis actually names.
--
-- ponytail: an organiser's revenue list shows "a former attendee" from
-- erased_subject_id being non-null, without needing the label. Give hosts the
-- pseudonym for subjects appearing on their own events if a screen ever wants
-- to group by it.
-- ---------------------------------------------------------------------------

alter table public.data_subject_erasures enable row level security;

create policy data_subject_erasures_select on public.data_subject_erasures
  for select to authenticated
  using (public.is_admin());

create trigger log_data_subject_erasures
  after insert or update or delete on public.data_subject_erasures
  for each row execute function public.log_activity();

grant select on public.data_subject_erasures to authenticated;

grant execute on function public.erasure_retention_years() to authenticated;
grant execute on function public.purge_expired_erasures()  to authenticated;
